/**
 * 图谱力导向布局 worker：把 O(n²)×数百步的收敛计算搬到独立线程，
 * 主线程只负责收结果再补动画。
 */
import { converge, type ForceLayoutRequest, type ForceLayoutResponse } from './graphForce'

// Worker 里 self 是 DedicatedWorkerGlobalScope。为一个文件引入 webworker lib 会和
// DOM lib 的同名全局（self / postMessage）冲突，所以这里只声明用到的两个成员。
declare const self: {
  onmessage: ((event: MessageEvent<ForceLayoutRequest>) => void) | null
  postMessage: (message: ForceLayoutResponse) => void
}

self.onmessage = (event) => {
  const { reqId, ids, links, width, height, anchors } = event.data
  const result = converge(ids, links, {
    width,
    height,
    anchors: new Map(anchors),
  })
  self.postMessage({
    reqId,
    positions: ids.map((id) => [id, result.get(id)!]),
  })
}
