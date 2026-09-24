import { useEffect, useMemo, useState } from 'react'
import { Canvas, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { getCore } from '../../services/synapse'
import styles from './index.module.scss'

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

const WIDTH = 335
const HEIGHT = 420

/** G1：环上节点按掌握度着色——静态结构图变成学情诊断图。 */
const MASTERY_ORDER = ['mastered', 'learning', 'weak', 'untouched'] as const

const MASTERY_COLORS: Record<string, string> = {
  mastered: '#059669',
  learning: '#d97706',
  weak: '#dc2626',
  untouched: '#cbd5e1'
}

const MASTERY_LABELS: Record<string, string> = {
  mastered: '已掌握',
  learning: '在学',
  weak: '薄弱',
  untouched: '未学'
}

export default function GraphPage() {
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [mastery, setMastery] = useState<Record<string, MasteryEntry>>({})
  const [counts, setCounts] = useState<Record<string, number>>({})

  const positions = useMemo(() => {
    const result = new Map<string, { x: number; y: number }>()
    const courseNodes = nodes.filter((node) => node.category === 'course')
    const outerNodes = nodes.filter((node) => node.category !== 'course')
    courseNodes.forEach((node, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(1, courseNodes.length)
      result.set(node.id, {
        x: WIDTH / 2 + Math.cos(angle) * Math.min(36, courseNodes.length * 14),
        y: HEIGHT / 2 + Math.sin(angle) * Math.min(36, courseNodes.length * 14)
      })
    })
    outerNodes.forEach((node, index) => {
      const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(1, outerNodes.length)
      const radius = outerNodes.length > 18 && index % 2 ? 155 : 125
      result.set(node.id, {
        x: WIDTH / 2 + Math.cos(angle) * radius,
        y: HEIGHT / 2 + Math.sin(angle) * radius
      })
    })
    return result
  }, [nodes])

  const load = () => {
    const result = getCore().getKnowledgeGraph()
    const data = (result.data ?? {}) as Record<string, unknown>
    const nextNodes = (data['nodes'] ?? []) as GraphNode[]
    setNodes(nextNodes)
    setEdges((data['edges'] ?? []) as GraphEdge[])
    setSelectedId((current) => current || nextNodes[0]?.id || '')

    const masteryData = (getCore().getKgMastery().data ?? {}) as Record<string, unknown>
    const entries = (masteryData['entries'] ?? []) as MasteryEntry[]
    const byNode: Record<string, MasteryEntry> = {}
    for (const entry of entries) {
      byNode[entry.node_id] = entry
    }
    setMastery(byNode)
    setCounts({
      mastered: Number(masteryData['mastered'] ?? 0),
      learning: Number(masteryData['learning'] ?? 0),
      weak: Number(masteryData['weak'] ?? 0),
      untouched: Number(masteryData['untouched'] ?? 0)
    })
  }

  useDidShow(load)

  useEffect(() => {
    if (!nodes.length) {
      return
    }
    const context = Taro.createCanvasContext('knowledge-graph')
    context.setStrokeStyle('#ccd6e3')
    context.setLineWidth(1)
    context.setFillStyle('#93a0ae')
    context.setFontSize(7)
    edges.forEach((edge) => {
      const source = positions.get(edge.source_id)
      const target = positions.get(edge.target_id)
      if (!source || !target) {
        return
      }
      context.beginPath()
      context.moveTo(source.x, source.y)
      context.lineTo(target.x, target.y)
      context.stroke()
      context.fillText(edge.relation, (source.x + target.x) / 2, (source.y + target.y) / 2 - 3)
    })
    context.draw()
  }, [edges, nodes, positions])

  const selected = nodes.find((node) => node.id === selectedId)
  const selectedLevel = (selected && mastery[selected.id]?.level) || 'untouched'

  return (
    <View className={styles.page}>
      <View className={styles.summary}>
        <Text className={styles.title}>从你的资料里生长的学习路径</Text>
        <Text className={styles.desc}>
          {nodes.length === 0
            ? '图谱还是空的：去资料库导入资料并点「构建图谱」'
            : `${nodes.length} 个节点 · ${edges.length} 条关系 · 颜色是掌握度`}
        </Text>
      </View>

      <View className={styles.legend}>
        {MASTERY_ORDER.map((level) => (
          <View key={level} className={styles.legendItem}>
            <View
              className={styles.legendDot}
              style={{ backgroundColor: MASTERY_COLORS[level] }}
            />
            <Text className={styles.legendText}>
              {MASTERY_LABELS[level]} {counts[level] ?? 0}
            </Text>
          </View>
        ))}
      </View>

      <View className={styles.graphStage}>
        <Canvas canvasId="knowledge-graph" className={styles.canvas} />
        {nodes.map((node) => {
          const point = positions.get(node.id)
          if (!point) {
            return null
          }
          const level = mastery[node.id]?.level || 'untouched'
          return (
            <View
              key={node.id}
              className={`${styles.node} ${selectedId === node.id ? styles.nodeActive : ''}`}
              style={{
                left: `${(point.x / WIDTH) * 100}%`,
                top: `${(point.y / HEIGHT) * 100}%`,
                backgroundColor: MASTERY_COLORS[level] || MASTERY_COLORS.untouched
              }}
              onClick={() => setSelectedId(node.id)}
            >
              <Text
                className={styles.nodeText}
                style={{ color: level === 'untouched' ? '#4f515a' : '#fff' }}
              >
                {node.name.length > 6 ? `${node.name.slice(0, 6)}…` : node.name}
              </Text>
            </View>
          )
        })}
      </View>

      {!!selected && (
        <View className={styles.detail}>
          <Text className={styles.detailTitle}>{selected.name}</Text>
          <View className={styles.tags}>
            <Text className={styles.tag}>{selected.category}</Text>
            <Text className={styles.tag}>{selected.subject || '未分类'}</Text>
            <Text
              className={styles.tag}
              style={{
                backgroundColor: MASTERY_COLORS[selectedLevel],
                color: selectedLevel === 'untouched' ? '#4f515a' : '#fff'
              }}
            >
              {MASTERY_LABELS[selectedLevel]}
            </Text>
          </View>
          <Text className={styles.desc}>{selected.description || '暂无说明'}</Text>
          <Text className={styles.desc}>
            {mastery[selected.id]?.card_count
              ? `依据 ${mastery[selected.id]!.card_count} 张复习卡判定：${mastery[selected.id]!.reason}`
              : '这个知识点还没有对应的复习卡，先去资料库「一键学习化」把它变成复习卡。'}
          </Text>
        </View>
      )}
    </View>
  )
}
