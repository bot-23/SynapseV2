import { useEffect, useMemo, useState } from 'react'
import { detect_document_subject } from '@synapse/core'
import { getCore } from '../services/synapse'
import PageIntro from '../components/PageIntro'
import { converge, initialPositions, type ForceAnchor, type Point } from './graphForce'

interface GraphNode {
  id: string
  name: string
  category: string
  subject: string
  description: string
}

interface GraphEdge {
  source_id: string
  target_id: string
  relation: string
}

interface MasteryEntry {
  node_id: string
  level: string
  card_count: number
  reason: string
}

interface GraphViewProps {
  onBack: () => void
}

interface Cluster {
  key: string
  label: string
  nodeIds: string[]
}

const VIEW_WIDTH = 720
const VIEW_HEIGHT = 520
/** 收敛后把节点挪到目标位置的时长：走得慢一点才不显得抽搐 */
const SETTLE_MS = 1000
/** 簇与簇之间留白、以及簇内节点到格位边界的安全距离 */
const CELL_PADDING = 24
const NODE_MARGIN = 30
/** 知识点小球与资料中枢的半径 */
const NODE_RADIUS = 13
const HUB_RADIUS = 17

const MASTERY_ORDER = ['mastered', 'learning', 'weak', 'untouched'] as const

const MASTERY_COLORS: Record<string, string> = {
  mastered: '#059669',
  learning: '#d97706',
  weak: '#dc2626',
  // 未学节点用低饱和灰，一眼和「学过的」区分开
  untouched: '#cbd5e1',
}

const MASTERY_LABELS: Record<string, string> = {
  mastered: '已掌握',
  learning: '在学',
  weak: '薄弱',
  untouched: '未学',
}

/** 资料节点的名字是文件名：先去扩展名再截断，免得标签尾巴挂一个"." */
function displayName(name: string): string {
  const trimmed = name.replace(/\.[a-z0-9]{2,4}$/i, '')
  return trimmed.length > 9 ? `${trimmed.slice(0, 9)}…` : trimmed
}

/**
 * 每个簇分到一块自己的格位：同簇节点共用格位中心与半径，
 * 于是不同学科各占一块、不会互相挤到画布角落。
 */
function anchorsOf(
  clusterIds: ReadonlyArray<readonly string[]>,
): Map<string, ForceAnchor> {
  const result = new Map<string, ForceAnchor>()
  const columns = clusterIds.length <= 3 ? Math.max(1, clusterIds.length) : Math.ceil(Math.sqrt(clusterIds.length))
  const rows = Math.max(1, Math.ceil(clusterIds.length / columns))
  const cellWidth = (VIEW_WIDTH - CELL_PADDING * 2) / columns
  const cellHeight = (VIEW_HEIGHT - CELL_PADDING * 2) / rows
  const radius = Math.max(56, Math.min(cellWidth, cellHeight) / 2 - NODE_MARGIN)
  clusterIds.forEach((ids, index) => {
    const x = CELL_PADDING + cellWidth * ((index % columns) + 0.5)
    const y = CELL_PADDING + cellHeight * (Math.floor(index / columns) + 0.5)
    for (const id of ids) {
      result.set(id, { x, y, radius })
    }
  })
  return result
}

/**
 * 簇的标题：优先用真正的学科（配了 Key 时模型会给知识点填 subject），
 * 否则退回资料名——离线抽取时知识点没有学科，但资料名本身通常带科目。
 */
function clusterLabelOf(members: GraphNode[]): string {
  const subjectCounts = new Map<string, number>()
  for (const member of members) {
    const subject = member.subject.trim()
    if (!subject || subject === '未分类' || subject === '资料') {
      continue
    }
    subjectCounts.set(subject, (subjectCounts.get(subject) ?? 0) + 1)
  }
  let dominant = ''
  let dominantCount = 0
  for (const [subject, count] of subjectCounts) {
    if (count > dominantCount) {
      dominant = subject
      dominantCount = count
    }
  }
  if (dominant) {
    return dominant
  }

  const document = members.find((member) => member.category === 'document')
  const name = (document ?? members[0])?.name ?? '未分组'
  return detect_document_subject(name, '') || name.replace(/\.[a-z0-9]+$/i, '').slice(0, 12)
}

export default function GraphView({ onBack }: GraphViewProps) {
  const [{ nodes, edges, masteryResult, masteryByNode }] = useState(() => {
    const graph = (getCore().getKnowledgeGraph().data ?? {}) as Record<string, unknown>
    const mastery = (getCore().getKgMastery().data ?? {}) as Record<string, unknown>
    const entries = (mastery['entries'] ?? []) as MasteryEntry[]
    return {
      nodes: (graph['nodes'] ?? []) as GraphNode[],
      edges: (graph['edges'] ?? []) as GraphEdge[],
      masteryResult: mastery,
      masteryByNode: new Map(entries.map((entry) => [entry.node_id, entry])),
    }
  })

  const [scopeKey, setScopeKey] = useState('all')
  const [focusId, setFocusId] = useState('')

  // 邻接表：聚焦时用它找「一跳邻居」，分簇时用它找连通分量
  const adjacency = useMemo(() => {
    const result = new Map<string, Set<string>>()
    for (const node of nodes) {
      result.set(node.id, new Set())
    }
    for (const edge of edges) {
      result.get(edge.source_id)?.add(edge.target_id)
      result.get(edge.target_id)?.add(edge.source_id)
    }
    return result
  }, [nodes, edges])

  /**
   * 每份资料连出的知识点天然是一簇，不同学科根本不会连在一起，
   * 所以「按学科分开展示」直接用连通分量，不需要额外给节点打标。
   */
  const clusters = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const visited = new Set<string>()
    const result: Cluster[] = []
    for (const node of nodes) {
      if (visited.has(node.id)) {
        continue
      }
      const stack = [node.id]
      visited.add(node.id)
      const nodeIds: string[] = []
      while (stack.length) {
        const current = stack.pop()!
        nodeIds.push(current)
        for (const next of adjacency.get(current) ?? []) {
          if (!visited.has(next) && byId.has(next)) {
            visited.add(next)
            stack.push(next)
          }
        }
      }
      result.push({
        key: `cluster-${result.length}`,
        label: clusterLabelOf(nodeIds.map((id) => byId.get(id)!)),
        nodeIds,
      })
    }
    return result.sort((a, b) => b.nodeIds.length - a.nodeIds.length || a.key.localeCompare(b.key))
  }, [nodes, adjacency])

  const scopeSet = useMemo(() => {
    const picked = clusters.find((cluster) => cluster.key === scopeKey)
    return picked ? new Set(picked.nodeIds) : new Set(nodes.map((node) => node.id))
  }, [clusters, scopeKey, nodes])

  // 聚焦 = 只留被点的节点和它的直接邻居，其余淡出；点空白恢复整个学科
  const activeSet = useMemo(() => {
    if (!focusId || !scopeSet.has(focusId)) {
      return scopeSet
    }
    const result = new Set([focusId])
    for (const next of adjacency.get(focusId) ?? []) {
      if (scopeSet.has(next)) {
        result.add(next)
      }
    }
    return result
  }, [focusId, scopeSet, adjacency])

  const activeIds = useMemo(
    () => nodes.filter((node) => activeSet.has(node.id)).map((node) => node.id),
    [nodes, activeSet],
  )

  const anchors = useMemo(
    () =>
      anchorsOf(
        clusters
          .map((cluster) => cluster.nodeIds.filter((id) => activeSet.has(id)))
          .filter((ids) => ids.length > 0),
      ),
    [clusters, activeSet],
  )

  const [positions, setPositions] = useState(() =>
    initialPositions(
      nodes.map((node) => node.id),
      anchors,
      VIEW_WIDTH,
      VIEW_HEIGHT,
    ),
  )

  // 可见集合一变就重算目标位置，再从当前位置缓动过去。布局是一次算到底的
  // 纯计算（几毫秒），所以"动"的只有这段缓动，速度完全可控、不会抽搐。
  useEffect(() => {
    if (!activeIds.length) {
      return
    }
    const indexOf = new Map(activeIds.map((id, index) => [id, index]))
    const target = converge(
      activeIds,
      edges
        .filter((edge) => indexOf.has(edge.source_id) && indexOf.has(edge.target_id))
        .map((edge) => [indexOf.get(edge.source_id)!, indexOf.get(edge.target_id)!] as const),
      { width: VIEW_WIDTH, height: VIEW_HEIGHT, anchors },
    )

    const from = new Map<string, Point>()
    for (const id of activeIds) {
      from.set(id, positions.get(id) ?? target.get(id)!)
    }

    const startedAt = performance.now()
    let handle = 0
    const tick = (now: number) => {
      const progress = Math.min(1, Math.max(0, (now - startedAt) / SETTLE_MS))
      // smoothstep：两头慢中间快，比线性更像"自然落位"
      const eased = progress * progress * (3 - 2 * progress)
      setPositions((previous) => {
        const next = new Map(previous)
        for (const [id, start] of from) {
          const end = target.get(id)!
          next.set(id, {
            x: start.x + (end.x - start.x) * eased,
            y: start.y + (end.y - start.y) * eased,
          })
        }
        return next
      })
      if (progress < 1) {
        handle = requestAnimationFrame(tick)
      }
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
    // positions 只在开头读一次当起点，故意不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIds, anchors, edges])

  const selected = nodes.find((node) => node.id === focusId) ?? null
  const selectedMastery = selected ? masteryByNode.get(selected.id) : undefined
  const scopeEdges = edges.filter(
    (edge) => scopeSet.has(edge.source_id) && scopeSet.has(edge.target_id),
  )

  const openNode = (id: string) => {
    setFocusId((current) => (current === id ? '' : id))
  }

  return (
    <div className="graph-page">
      <PageIntro
        eyebrow="CONNECTIONS & MASTERY / 06"
        title="个人知识图谱"
        description="看见知识之间的联系，也看清哪些内容值得再复习。"
      />
      <div className="graph-header">
        <button type="button" className="graph-back" onClick={onBack}>
          返回我的
        </button>
        <div>
          <div className="card-title">图谱概览</div>
          <div className="card-desc">
            {nodes.length === 0
              ? '图谱还是空的。去资料库导入学习资料并点「构建图谱」，节点和关系会出现在这里。'
              : `${scopeSet.size} 个知识点 · ${scopeEdges.length} 条关系。填充色是掌握度，点节点看判定理由。`}
          </div>
        </div>
      </div>

      {clusters.length > 1 && (
        <div className="graph-scope" role="group" aria-label="按学科筛选图谱">
          <button
            type="button"
            className={`graph-scope-chip${scopeKey === 'all' ? ' active' : ''}`}
            onClick={() => {
              setScopeKey('all')
              setFocusId('')
            }}
          >
            全部
          </button>
          {clusters.map((cluster) => (
            <button
              key={cluster.key}
              type="button"
              className={`graph-scope-chip${scopeKey === cluster.key ? ' active' : ''}`}
              onClick={() => {
                setScopeKey(cluster.key)
                setFocusId('')
              }}
            >
              {cluster.label}
              <span className="graph-scope-count">{cluster.nodeIds.length}</span>
            </button>
          ))}
        </div>
      )}

      <div className="graph-legend">
        {MASTERY_ORDER.map((level) => (
          <span key={level} className="graph-legend-item">
            <i
              className="graph-legend-dot"
              style={{ background: MASTERY_COLORS[level] }}
              aria-hidden="true"
            />
            {MASTERY_LABELS[level]} {Number(masteryResult?.[level] ?? 0)}
          </span>
        ))}
      </div>

      <div className="graph-stage">
        <svg
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          role="img"
          aria-label="个人知识图谱"
          onClick={() => setFocusId('')}
        >
          {edges.map((edge, index) => {
            const source = positions.get(edge.source_id)
            const target = positions.get(edge.target_id)
            if (!source || !target) {
              return null
            }
            const shown = activeSet.has(edge.source_id) && activeSet.has(edge.target_id)
            const mx = (source.x + target.x) / 2
            const my = (source.y + target.y) / 2
            return (
              <g
                key={`${edge.source_id}-${edge.target_id}-${edge.relation}-${index}`}
                className={`graph-edge-group${shown ? '' : ' dim'}`}
              >
                <line
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  className="graph-edge"
                />
                {/* contains 是「资料 → 知识点」的默认结构关系，每颗星上都有；标出来只是噪音，
                    只标 prerequisite_of / recommends / practice_for 这类真正有信息量的关系 */}
                {edge.relation !== 'contains' && (
                  <text x={mx} y={my - 4} className="graph-edge-label">
                    {edge.relation}
                  </text>
                )}
              </g>
            )
          })}
          {nodes.map((node) => {
            const point = positions.get(node.id)
            if (!point) {
              return null
            }
            const active = node.id === focusId
            const shown = activeSet.has(node.id)
            const mastery = masteryByNode.get(node.id)
            // 资料是这簇的中枢，画大一点并加一圈淡淡的外环；
            // 颜色只留掌握度一个通道——之前再叠一圈类别色，两个饱和色互相打架。
            const hub = node.category === 'document' || node.category === 'course'
            const radius = hub ? HUB_RADIUS : NODE_RADIUS
            return (
              <g
                key={node.id}
                className={`graph-node${active ? ' active' : ''}${shown ? '' : ' dim'}`}
                onClick={(event) => {
                  event.stopPropagation()
                  openNode(node.id)
                }}
                role="button"
                tabIndex={0}
              >
                {hub && (
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={radius + 6}
                    fill="none"
                    className="graph-node-halo"
                  />
                )}
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={radius}
                  fill={MASTERY_COLORS[mastery?.level ?? 'untouched']}
                />
                <text x={point.x} y={point.y + radius + 14} textAnchor="middle">
                  {displayName(node.name)}
                </text>
              </g>
            )
          })}
        </svg>
      </div>

      <div className="graph-hint">
        {focusId
          ? `正在看「${selected?.name ?? ''}」和它的 ${Math.max(0, activeSet.size - 1)} 个直接相邻知识点，点空白处恢复全部。`
          : '点一个节点，就只看它和它直接相邻的知识点；上方可以按学科分开看。'}
      </div>

      {selected && (
        <div className="mine-card graph-detail">
          <div className="graph-detail-title">{selected.name}</div>
          <div className="graph-tags">
            <span>{selected.category}</span>
            <span>{selected.subject || '未分类'}</span>
            <span className={`graph-mastery graph-mastery-${selectedMastery?.level ?? 'untouched'}`}>
              {MASTERY_LABELS[selectedMastery?.level ?? 'untouched']}
            </span>
          </div>
          <div className="card-desc">{selected.description || '暂无说明'}</div>
          <div className="card-desc">
            {selectedMastery?.card_count
              ? `依据 ${selectedMastery.card_count} 张复习卡判定：${selectedMastery.reason}`
              : '这个知识点还没有对应的复习卡，先去资料库「一键学习化」把它变成复习卡。'}
          </div>
        </div>
      )}
    </div>
  )
}
