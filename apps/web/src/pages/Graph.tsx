import { useMemo, useState } from 'react'
import { getCore } from '../services/synapse'

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

interface GraphViewProps {
  onBack: () => void
}

const COLORS: Record<string, string> = {
  course: '#6957c6',
  topic: '#2f80ed',
  strategy: '#d97706',
  task: '#059669',
  document: '#db2777',
}

export default function GraphView({ onBack }: GraphViewProps) {
  const graph = getCore().getKnowledgeGraph().data as Record<string, unknown>
  const nodes = (graph?.['nodes'] ?? []) as GraphNode[]
  const edges = (graph?.['edges'] ?? []) as GraphEdge[]
  const [selectedId, setSelectedId] = useState(nodes[0]?.id ?? '')

  const positions = useMemo(() => {
    const center = { x: 360, y: 260 }
    const result = new Map<string, { x: number; y: number }>()
    const courseNodes = nodes.filter((node) => node.category === 'course')
    const outerNodes = nodes.filter((node) => node.category !== 'course')
    courseNodes.forEach((node, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(1, courseNodes.length)
      result.set(node.id, {
        x: center.x + Math.cos(angle) * Math.min(80, courseNodes.length * 24),
        y: center.y + Math.sin(angle) * Math.min(80, courseNodes.length * 24),
      })
    })
    outerNodes.forEach((node, index) => {
      const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(1, outerNodes.length)
      const radius = outerNodes.length > 18 && index % 2 ? 210 : 175
      result.set(node.id, {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
      })
    })
    return result
  }, [nodes])

  const selected = nodes.find((node) => node.id === selectedId) ?? null

  return (
    <div className="graph-page">
      <div className="graph-header">
        <button type="button" className="graph-back" onClick={onBack}>
          返回我的
        </button>
        <div>
          <div className="card-title">个人知识图谱</div>
          <div className="card-desc">
            {nodes.length} 个节点 · {edges.length} 条关系。点击节点查看资料来源与说明。
          </div>
        </div>
      </div>

      <div className="graph-stage">
        <svg viewBox="0 0 720 520" role="img" aria-label="个人知识图谱">
          {edges.map((edge, index) => {
            const source = positions.get(edge.source_id)
            const target = positions.get(edge.target_id)
            if (!source || !target) {
              return null
            }
            const mx = (source.x + target.x) / 2
            const my = (source.y + target.y) / 2
            return (
              <g key={`${edge.source_id}-${edge.target_id}-${edge.relation}-${index}`}>
                <line
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  className="graph-edge"
                />
                <text x={mx} y={my - 4} className="graph-edge-label">
                  {edge.relation}
                </text>
              </g>
            )
          })}
          {nodes.map((node) => {
            const point = positions.get(node.id)
            if (!point) {
              return null
            }
            const active = node.id === selectedId
            return (
              <g
                key={node.id}
                className={`graph-node${active ? ' active' : ''}`}
                onClick={() => setSelectedId(node.id)}
                role="button"
                tabIndex={0}
              >
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={node.category === 'course' ? 28 : 22}
                  fill={COLORS[node.category] ?? '#64748b'}
                />
                <text x={point.x} y={point.y + 38} textAnchor="middle">
                  {node.name.length > 9 ? `${node.name.slice(0, 9)}…` : node.name}
                </text>
              </g>
            )
          })}
        </svg>
      </div>

      {selected && (
        <div className="mine-card graph-detail">
          <div className="graph-detail-title">{selected.name}</div>
          <div className="graph-tags">
            <span>{selected.category}</span>
            <span>{selected.subject || '未分类'}</span>
          </div>
          <div className="card-desc">{selected.description || '暂无说明'}</div>
        </div>
      )}
    </div>
  )
}
