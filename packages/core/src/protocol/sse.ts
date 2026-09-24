/**
 * SSE 事件契约：先若干条 stage 事件报告进度，最后一条 done 携带完整结果。
 */

import type { StudyPilotRunResponse } from "./frontend.js";

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
