/**
 * SSE 事件契约。事件顺序与字段名以 baseline/golden/http_*run_stream.json 为冻结基线。
 */

import type { StudyPilotRunResponse } from "./frontend";

export interface StageEvent {
  type: "stage";
  label: string;
}

export interface DoneEvent {
  type: "done";
  result: StudyPilotRunResponse;
}

export type CopilotStreamEvent = StageEvent | DoneEvent;

/** 序列化为 SSE data 行（对应旧仓 emit()：`data: {json}\n\n`，ensure_ascii=False）。 */
export function encodeSseEvent(event: CopilotStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
