import { useState } from 'react'
import { View, Text, Button } from '@tarojs/components'
import classnames from 'classnames'
import type { BlockPlan } from '../../vendor/core'
import styles from './index.module.scss'

interface BlockPlanCardProps {
  blockPlan: BlockPlan
  expanding?: boolean
  onExpand: (blockPlan: BlockPlan) => void
}

/** 积木计划卡片：逐块可替换，确认后展开成一周计划 */
export default function BlockPlanCard({ blockPlan, expanding, onExpand }: BlockPlanCardProps) {
  const [current, setCurrent] = useState<BlockPlan>(blockPlan)

  const selectOption = (blockId: string, optionIndex: number) => {
    setCurrent((prev) => ({
      ...prev,
      blocks: prev.blocks.map((block) =>
        block.id === blockId ? { ...block, selectedIndex: optionIndex } : block
      )
    }))
  }

  return (
    <View className={styles.blockCard}>
      <View className={styles.blockHeader}>
        <Text className={styles.blockTitle}>{current.day} 积木计划</Text>
        <Text className={styles.blockLimit}>限时 {current.limitMinutes} 分钟</Text>
      </View>
      {!!current.description && <Text className={styles.blockDesc}>{current.description}</Text>}

      {current.blocks.map((block) => (
        <View key={block.id} className={styles.blockItem}>
          <Text className={styles.blockLabel}>{block.label}</Text>
          {block.options.map((option, optionIndex) => {
            const active = optionIndex === block.selectedIndex
            return (
              <View
                key={`${block.id}-${optionIndex}`}
                className={classnames(styles.option, active && styles.optionActive)}
                onClick={() => selectOption(block.id, optionIndex)}
              >
                <View className={styles.optionTop}>
                  <Text className={classnames(styles.optionTitle, active && styles.optionTitleActive)}>
                    {option.title}
                  </Text>
                  <Text className={styles.optionDuration}>{option.duration}分钟</Text>
                </View>
                {!!option.detail && <Text className={styles.optionDetail}>{option.detail}</Text>}
              </View>
            )
          })}
        </View>
      ))}

      <Button className={styles.expandButton} disabled={expanding} onClick={() => onExpand(current)}>
        {expanding ? '展开中…' : '确认这套积木，展开成一周计划'}
      </Button>
      <Text className={styles.expandHint}>展开后会自动保存为当前计划，并同步到「计划」页</Text>
    </View>
  )
}
