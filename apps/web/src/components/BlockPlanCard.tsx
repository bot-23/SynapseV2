import { useState } from 'react'
import type { BlockPlan } from '@synapse/core'

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
        block.id === blockId ? { ...block, selectedIndex: optionIndex } : block,
      ),
    }))
  }

  return (
    <div className="block-plan-card">
      <div className="block-plan-header">
        <span className="block-plan-day">{current.day} 积木计划</span>
        <span className="block-plan-limit">限时 {current.limitMinutes} 分钟</span>
      </div>
      {!!current.description && <div className="block-plan-desc">{current.description}</div>}

      {current.blocks.map((block) => (
        <div key={block.id} className="block-item">
          <div className="block-label">{block.label}</div>
          {block.options.map((option, optionIndex) => {
            const active = optionIndex === block.selectedIndex
            return (
              <div
                key={`${block.id}-${optionIndex}`}
                className={`block-option${active ? ' active' : ''}`}
                onClick={() => selectOption(block.id, optionIndex)}
              >
                <div className="block-option-top">
                  <span className={active ? 'block-option-title active' : 'block-option-title'}>
                    {option.title}
                  </span>
                  <span className="block-option-duration">{option.duration} 分钟</span>
                </div>
                {!!option.detail && <div className="block-option-detail">{option.detail}</div>}
              </div>
            )
          })}
        </div>
      ))}

      <button
        type="button"
        className="block-expand-button"
        disabled={expanding}
        onClick={() => onExpand(current)}
      >
        {expanding ? '展开中…' : '确认这套积木，展开成一周计划'}
      </button>
      <div className="block-expand-hint">展开后会自动保存为当前计划，并同步到「计划」页</div>
    </div>
  )
}