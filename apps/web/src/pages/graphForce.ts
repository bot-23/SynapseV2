/**
 * 力导向布局：把「节点平均铺在圆环上」的静态排布，换成会自己收敛的图。
 *
 * 纯计算模块——不碰 DOM、不依赖 React。对外只暴露两件事：从哪儿出发
 * （`initialPositions`）和收敛到哪儿（`converge`）；中间怎么抖动由调用方决定。
 * 逐帧跑物理的写法起手几帧位移极大、看着抽搐，所以这里一次算到底再让上游补动画。
 *
 * 沿用 Fruchterman-Reingold 的思路：斥力把节点推开、连线把它们拉近、
 * 力度上限（温度）随步数降低，跑到温度归零就是收敛。
 *
 * 每个节点带一个"格位"（anchor + radius）：同簇节点共用一个格位，
 * 于是不同学科各占一块、不会互相挤成角落，簇内也不会被撑散。
 */

export interface Point {
  x: number
  y: number
}

export interface ForceAnchor extends Point {
  /** 这个簇能占用的半径；超出就被柔和地拉回来 */
  radius: number
}

export interface ForceLayoutOptions {
  width: number
  height: number
  anchors: ReadonlyMap<string, ForceAnchor>
}

const COOLING = 0.99
const MIN_TEMPERATURE = 0.05
const MAX_STEPS = 3000
const MIN_GAP = 44
const MAX_GAP = 92
/** 画布内边距：布局的兜底约束，正常情况下由格位边界先起作用 */
const PADDING = 52
/** 向心力：让节点老老实实待在格位中心附近 */
const GRAVITY = 0.1
/** 越界回拉的刚度：只把溢出的部分拉回来，不干扰簇内的平衡 */
const BOUNDARY = 0.8
/** 跨簇斥力的折扣：格位已经保证了簇与簇的间距，这里只需要一点"别贴上来"的推力 */
const CROSS_CLUSTER_REPULSION = 0.15

interface ForceNode extends Point {
  id: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 出发位置：每个节点在它所属格位中心附近聚一小圈。
 * 收敛结果由出发位置决定，所以它同时是「首帧画在哪」和「布局的初始状态」。
 */
export function initialPositions(
  ids: readonly string[],
  anchors: ReadonlyMap<string, ForceAnchor>,
  width: number,
  height: number,
): Map<string, Point> {
  const result = new Map<string, Point>()
  ids.forEach((id, index) => {
    const anchor = anchors.get(id) ?? { x: width / 2, y: height / 2, radius: MAX_GAP }
    const start = Math.min(42, anchor.radius * 0.5)
    const angle = (Math.PI * 2 * index) / Math.max(1, ids.length)
    result.set(id, {
      x: anchor.x + Math.cos(angle) * start,
      y: anchor.y + Math.sin(angle) * start,
    })
  })
  return result
}

/** 一次把布局算到收敛，返回每个节点的目标位置。 */
export function converge(
  ids: readonly string[],
  links: ReadonlyArray<readonly [number, number]>,
  options: ForceLayoutOptions,
): Map<string, Point> {
  const { width, height, anchors } = options
  const centerX = width / 2
  const centerY = height / 2
  const count = ids.length

  const anchorOf = (id: string): ForceAnchor =>
    anchors.get(id) ?? { x: centerX, y: centerY, radius: MAX_GAP }

  /** 同簇 = 共用同一个格位中心 */
  const sameCluster = (a: string, b: string): boolean => {
    const left = anchorOf(a)
    const right = anchorOf(b)
    return left.x === right.x && left.y === right.y
  }

  // 理想边长：取格位半径，簇就自然铺到自己的边界上而不越界
  const totalRadius = ids.reduce((sum, id) => sum + anchorOf(id).radius, 0)
  const gap = count > 0 ? clamp(totalRadius / count, MIN_GAP, MAX_GAP) : MIN_GAP

  const seed = initialPositions(ids, anchors, width, height)
  const nodes: ForceNode[] = ids.map((id) => {
    const start = seed.get(id)!
    return { id, x: start.x, y: start.y }
  })

  const pushX = new Float64Array(count)
  const pushY = new Float64Array(count)
  let temperature = gap

  const step = () => {
    pushX.fill(0)
    pushY.fill(0)

    // 斥力：两两互推，离得越近推得越狠
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        let dx = nodes[i]!.x - nodes[j]!.x
        let dy = nodes[i]!.y - nodes[j]!.y
        let distance = Math.hypot(dx, dy)
        if (distance < 0.01) {
          // 两点完全重合时给一个确定性的偏移，避免除以零
          dx = ((i % 3) - 1) || 0.01
          dy = ((j % 3) - 1) || 0.01
          distance = Math.hypot(dx, dy)
        }
        const force =
          ((gap * gap) / distance) *
          (sameCluster(nodes[i]!.id, nodes[j]!.id) ? 1 : CROSS_CLUSTER_REPULSION)
        const ux = (dx / distance) * force
        const uy = (dy / distance) * force
        pushX[i]! += ux
        pushY[i]! += uy
        pushX[j]! -= ux
        pushY[j]! -= uy
      }
    }

    // 引力：有关系的节点互相拉近，关系越远（当前距离越大）拉得越狠
    for (const [source, target] of links) {
      const a = nodes[source]
      const b = nodes[target]
      if (!a || !b) {
        continue
      }
      const dx = a.x - b.x
      const dy = a.y - b.y
      const distance = Math.max(0.01, Math.hypot(dx, dy))
      const force = (distance * distance) / gap
      const ux = (dx / distance) * force
      const uy = (dy / distance) * force
      pushX[source]! -= ux
      pushY[source]! -= uy
      pushX[target]! += ux
      pushY[target]! += uy
    }

    // 向心 + 格位边界 + 限幅：单步位移不超过当前温度，于是越来越"定得住"
    for (let i = 0; i < count; i += 1) {
      const node = nodes[i]!
      const anchor = anchorOf(node.id)

      pushX[i]! += (anchor.x - node.x) * GRAVITY
      pushY[i]! += (anchor.y - node.y) * GRAVITY

      const outX = node.x - anchor.x
      const outY = node.y - anchor.y
      const outDistance = Math.hypot(outX, outY)
      if (outDistance > anchor.radius) {
        const pull = (outDistance - anchor.radius) * BOUNDARY
        pushX[i]! -= (outX / outDistance) * pull
        pushY[i]! -= (outY / outDistance) * pull
      }

      const dx = pushX[i]!
      const dy = pushY[i]!
      const length = Math.hypot(dx, dy)
      if (length > 0.001) {
        const limited = Math.min(length, temperature)
        node.x = clamp(node.x + (dx / length) * limited, PADDING, width - PADDING)
        node.y = clamp(node.y + (dy / length) * limited, PADDING, height - PADDING)
      }
    }

    temperature *= COOLING
    if (temperature < MIN_TEMPERATURE) {
      temperature = 0
    }
  }

  let guard = 0
  while (temperature > 0 && guard < MAX_STEPS) {
    step()
    guard += 1
  }

  return new Map(nodes.map((node) => [node.id, { x: node.x, y: node.y }]))
}
