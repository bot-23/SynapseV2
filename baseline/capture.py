"""P0 基线捕获：从旧仓（Synapse）提取接口契约与行为黄金样本。

安全约束：
- 全程使用临时数据目录（SYNAPSE_DATA_DIR/DB_PATH/APP_STATE_DIR），不触用户数据库。
- LLM 走 Mock（无 API Key），不产生真实模型调用与费用。
- 对旧仓只读：不修改旧仓任何文件。

用法（工作目录建议为旧仓 backend/，但脚本自带 sys.path 处理）：
    uv run --with httpx python <本文件> --out <SynapseNext>/baseline

重复执行两次应产生完全一致（按内容哈希）的 golden 文件。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path

OLD_REPO = Path(os.environ.get("SYNAPSE_OLD_REPO", r"C:\Users\23\Desktop\items\Synapse"))


def setup_env() -> tempfile.TemporaryDirectory:
    """在导入任何旧仓模块之前配置隔离环境。"""
    tmp = tempfile.TemporaryDirectory(prefix="synapse-baseline-", ignore_cleanup_errors=True)
    os.environ["SYNAPSE_DATA_DIR"] = tmp.name
    os.environ["DB_PATH"] = str(Path(tmp.name) / "synapse.db")
    os.environ["APP_STATE_DIR"] = tmp.name
    os.environ["LLM_PROVIDER"] = "mock"
    os.environ.pop("DEEPSEEK_API_KEY", None)
    sys.path.insert(0, str(OLD_REPO / "backend"))
    sys.path.insert(0, str(OLD_REPO))
    return tmp


# ---------------------------------------------------------------------------
# 归一化：抹掉每次运行都变化的值，保证黄金样本可 diff
# ---------------------------------------------------------------------------

_UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
_ISO_TS_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?")


def normalize(value):
    if isinstance(value, dict):
        return {k: normalize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [normalize(v) for v in value]
    if isinstance(value, str):
        value = _UUID_RE.sub("<uuid>", value)
        value = _ISO_TS_RE.sub("<timestamp>", value)
        return value
    return value


def to_jsonable(value):
    from pydantic import BaseModel

    if isinstance(value, BaseModel):
        return to_jsonable(value.model_dump())
    if isinstance(value, dict):
        return {k: to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_jsonable(v) for v in value]
    return value


def dump(out_dir: Path, name: str, payload) -> None:
    golden = out_dir / "golden"
    golden.mkdir(parents=True, exist_ok=True)
    path = golden / name
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )
    print(f"  wrote golden/{name}")


# ---------------------------------------------------------------------------
# HTTP 级捕获
# ---------------------------------------------------------------------------

RUN_PAYLOAD = {
    "input": "帮我准备高等数学期末考试，还有 14 天，每天能学 90 分钟",
    "files": [],
    "userProfile": {"name": "基线同学", "grade": "大二"},
    "planningMode": "free",
}

BLOCKS_PAYLOAD = {**RUN_PAYLOAD, "planningMode": "blocks"}

NORMALIZED_REQUEST = {
    "user_id": "default",
    "current_level": "大二",
    "learning_goal": "准备高等数学期末考试",
    "available_days_per_week": 5,
    "available_minutes_per_day": 90,
    "deadline": "2026-10-02",
    "weak_points": ["积分", "极限"],
    "preferences": [],
    "need_user_confirmation": True,
}


def step(name: str, response) -> dict:
    try:
        body = response.json()
    except Exception:
        body = response.text
    return {"name": name, "status_code": response.status_code, "json": normalize(body)}


def _answers_for(clarification: dict) -> list[dict]:
    return [
        {
            "questionId": q.get("id", ""),
            "answer": (q.get("suggestedAnswers") or ["基线回答"])[0],
        }
        for q in clarification.get("questions", [])
    ]


def capture_http(client, api: str, out_dir: Path) -> None:
    # 基础端点 + 知识图谱摘要
    dump(out_dir, "http_core.json", [
        step("GET /healthz", client.get("/healthz")),
        step(f"GET {api}/health", client.get(f"{api}/health")),
        step(f"GET {api}/settings/status", client.get(f"{api}/settings/status")),
        step(f"GET {api}/copilot/knowledge-graph/summary", client.get(f"{api}/copilot/knowledge-graph/summary")),
    ])

    # 画像读写
    dump(out_dir, "http_profile.json", [
        step("GET profile (empty)", client.get(f"{api}/user/profile")),
        step("POST profile", client.post(f"{api}/user/profile", json={"name": "基线同学", "grade": "大二"})),
        step("GET profile (saved)", client.get(f"{api}/user/profile")),
    ])

    # 会话与消息 CRUD
    conv_id, msg_id = "conv-baseline-1", "msg-baseline-1"
    dump(out_dir, "http_conversations.json", [
        step("GET conversations (empty)", client.get(f"{api}/conversations")),
        step("POST conversation", client.post(
            f"{api}/conversations/{conv_id}",
            json={"title": "高数复习", "planning_mode": "free"},
        )),
        step("GET conversations (list)", client.get(f"{api}/conversations")),
        step("POST message", client.post(
            f"{api}/conversations/{conv_id}/messages/{msg_id}",
            json={"role": "user", "content": "帮我准备高等数学期末考试"},
        )),
        step("GET messages", client.get(f"{api}/conversations/{conv_id}/messages")),
        step("DELETE conversation", client.delete(f"{api}/conversations/{conv_id}")),
        step("GET conversations (after delete)", client.get(f"{api}/conversations")),
    ])

    # 自由规划模式（mock LLM）
    dump(out_dir, "http_copilot_run_free.json", [
        step("POST /copilot/run (free, mock)", client.post(f"{api}/copilot/run", json=RUN_PAYLOAD)),
    ])

    # SSE 流式（mock LLM）
    events = []
    with client.stream("POST", f"{api}/copilot/run/stream", json=RUN_PAYLOAD) as resp:
        for line in resp.iter_lines():
            if line.startswith("data: "):
                try:
                    events.append(json.loads(line[6:]))
                except json.JSONDecodeError:
                    events.append({"_raw": line})
    dump(out_dir, "http_copilot_run_stream.json", {
        "request": RUN_PAYLOAD,
        "events": normalize(events),
    })

    # 积木模式完整流程：run -> confirm -> expand-blocks
    # 注意：控制流必须用未归一化的原始响应取 sessionId/blockPlan，归一化仅用于落盘
    resp = client.post(f"{api}/copilot/run", json=BLOCKS_PAYLOAD)
    blocks_steps = [step("POST /copilot/run (blocks)", resp)]
    clarification = (resp.json() or {}).get("clarification") or {}
    session_id = clarification.get("sessionId")
    if session_id:
        resp = client.post(
            f"{api}/copilot/run/confirm",
            json={"sessionId": session_id, "answers": _answers_for(clarification)},
        )
        blocks_steps.append(step("POST /copilot/run/confirm", resp))
        block_plan = (resp.json() or {}).get("blockPlan")
        if block_plan:
            blocks_steps.append(step(
                "POST /copilot/run/expand-blocks",
                client.post(
                    f"{api}/copilot/run/expand-blocks",
                    json={"normalized": NORMALIZED_REQUEST, "blockPlan": block_plan},
                ),
            ))
        else:
            blocks_steps.append({"name": "expand-blocks", "skipped": "confirm 响应无 blockPlan"})
    else:
        blocks_steps.append({"name": "confirm", "skipped": "run 响应无 clarification"})
    dump(out_dir, "http_blocks_flow.json", blocks_steps)

    # 计划存储流：save -> current -> progress
    weekly_plan = [
        {
            "day_index": 1,
            "focus": "基线焦点",
            "tasks": [
                {"title": "基线任务", "task_type": "learn", "duration_minutes": 45, "reason": "基线理由"}
            ],
            "carry_over": [],
        }
    ]
    plan_body = {
        "user_id": "default",
        "plan": {"message": "基线计划", "plan": {"weekly_plan": weekly_plan}, "blockPlan": None},
    }
    dump(out_dir, "http_plan_storage.json", [
        step("POST /copilot/plan/save", client.post(f"{api}/copilot/plan/save", json=plan_body)),
        step("GET /copilot/plan/current", client.get(f"{api}/copilot/plan/current")),
        step("POST /copilot/plan/progress", client.post(f"{api}/copilot/plan/progress", json={
            "user_id": "default",
            "conversation_id": "conv-baseline-1",
            "plan_id": "",
            "task_key": "day-1::task-0",
            "done": True,
            "task_title": "基线任务",
            "task_type": "learn",
            "actual_minutes": 45,
            "plan_message": "基线计划",
        })),
    ])


# ---------------------------------------------------------------------------
# 假 LLM：describe() 自称 deepseek，使意图分类/计划生成主流程可被驱动。
# 不联网、零费用；所有返回均为预设常量。
# ---------------------------------------------------------------------------

FAKE_PLAN_CONTENT = json.dumps({
    "weekly_plan": [
        {
            "day_index": 1,
            "focus": "极限与连续",
            "tasks": [
                {"title": "梳理极限定义与判定条件", "task_type": "learn", "duration_minutes": 40, "reason": "先建主干，后续练习不容易发散。"},
                {"title": "限时完成一组极限计算题", "task_type": "practice", "duration_minutes": 50, "reason": "用题目暴露真实薄弱环节。"},
            ],
        },
        {
            "day_index": 2,
            "focus": "导数应用",
            "tasks": [
                {"title": "复盘导数错题并补一个知识缺口", "task_type": "review", "duration_minutes": 30, "reason": "避免只刷题不归纳。"},
                {"title": "做一次导数应用限时小测", "task_type": "mock_exam", "duration_minutes": 60, "reason": "验证计划是否覆盖关键问题。"},
            ],
        },
    ],
    "final_message": "这是基线假模型给出的鼓励语，用于固定响应形状。",
    "next_actions": ["基线建议一", "基线建议二"],
}, ensure_ascii=False)


class FakeLLM:
    """可编程假 LLM：generate_with_tools 返回预设工具，generate_text 返回预设计划 JSON。"""

    def __init__(self, tool_name: str = "create_plan", text: str = FAKE_PLAN_CONTENT) -> None:
        self.tool_name = tool_name
        self.text = text

    def describe(self) -> dict:
        return {"provider": "deepseek", "model": "fake-llm-v0", "status": "ready"}

    def generate_with_tools(self, prompt, tools, force_tool: str = "") -> dict:
        name = force_tool or self.tool_name
        args = {"goal": "准备高等数学期末考试", "subject": "高等数学"} if name == "create_plan" else {}
        return {"tool_calls": [{"name": name, "args": args}]}

    def generate_text(self, prompt: str) -> str:
        return self.text

    def stream_text(self, prompt: str):
        yield self.text[:20]
        yield self.text[20:]


def capture_fake(client, api: str, out_dir: Path) -> None:
    """注入 FakeLLM 后捕获主流程（计划生成、澄清、积木、流式）。"""
    from app.core import dependencies

    workflow = dependencies.get_workflow_service()
    workflow.providers.llm = FakeLLM()

    run_payload = {
        **RUN_PAYLOAD,
        "input": "帮我准备高等数学期末考试，还有 14 天，每天能学 90 分钟，给我制定计划",
    }

    # 自由模式主流程：run ->（若进入澄清）confirm -> 计划
    # 注意：控制流必须用未归一化的原始响应取 sessionId，归一化仅用于落盘
    resp = client.post(f"{api}/copilot/run", json=run_payload)
    free_steps = [step("POST /copilot/run (free, fake)", resp)]
    clarification = (resp.json() or {}).get("clarification") or {}
    session_id = clarification.get("sessionId")
    if session_id:
        free_steps.append(step(
            "POST /copilot/run/confirm",
            client.post(f"{api}/copilot/run/confirm", json={"sessionId": session_id, "answers": _answers_for(clarification)}),
        ))
    else:
        free_steps.append({"name": "confirm", "skipped": "run 直接出计划，未进入澄清"})
    dump(out_dir, "http_fake_free_flow.json", free_steps)

    # 积木模式主流程：run -> confirm -> expand-blocks
    blocks_payload = {**run_payload, "planningMode": "blocks"}
    resp = client.post(f"{api}/copilot/run", json=blocks_payload)
    blocks_steps = [step("POST /copilot/run (blocks, fake)", resp)]
    clarification = (resp.json() or {}).get("clarification") or {}
    session_id = clarification.get("sessionId")
    if session_id:
        resp = client.post(
            f"{api}/copilot/run/confirm",
            json={"sessionId": session_id, "answers": _answers_for(clarification)},
        )
        blocks_steps.append(step("POST /copilot/run/confirm", resp))
        confirm_json = resp.json() or {}
        block_plan = confirm_json.get("blockPlan")
        normalized = (confirm_json.get("request") or {}).get("normalized")
        if block_plan and normalized:
            blocks_steps.append(step(
                "POST /copilot/run/expand-blocks",
                client.post(f"{api}/copilot/run/expand-blocks", json={"normalized": normalized, "blockPlan": block_plan}),
            ))
        else:
            blocks_steps.append({"name": "expand-blocks", "skipped": "confirm 响应缺 blockPlan/normalized"})
    else:
        blocks_steps.append({"name": "confirm", "skipped": "run 响应无 clarification"})
    dump(out_dir, "http_fake_blocks_flow.json", blocks_steps)

    # 流式主流程
    events = []
    with client.stream("POST", f"{api}/copilot/run/stream", json=run_payload) as resp:
        for line in resp.iter_lines():
            if line.startswith("data: "):
                try:
                    events.append(json.loads(line[6:]))
                except json.JSONDecodeError:
                    events.append({"_raw": line})
    dump(out_dir, "http_fake_run_stream.json", {
        "request": run_payload,
        "events": normalize(events),
    })


# ---------------------------------------------------------------------------
# domain 纯算法级捕获（无网络、无数据库）
# ---------------------------------------------------------------------------

def capture_domain(out_dir: Path) -> None:
    from app.domain.block_plans import BlockPlanService
    from app.domain.rule_plans import RulePlanService
    from app.schemas.copilot import StudyPlanRequest

    rule = RulePlanService()
    block = BlockPlanService(
        infer_topic=rule.infer_topic,
        short_goal=rule.short_goal,
        duration=rule.duration,
    )

    def make_request(**overrides) -> StudyPlanRequest:
        return StudyPlanRequest(**{**NORMALIZED_REQUEST, **overrides})

    # 规则计划：三种计划类型 + 边界
    dump(out_dir, "domain_rule_plan.json", normalize(to_jsonable({
        "study": rule.generate_rule_plan(make_request()),
        "language": rule.generate_rule_plan(make_request(
            learning_goal="我想提升英语四级词汇和阅读",
            available_days_per_week=3,
            available_minutes_per_day=45,
        )),
        "assignment": rule.generate_rule_plan(make_request(
            learning_goal="两周内完成操作系统课程实验报告",
            available_days_per_week=7,
            available_minutes_per_day=120,
        )),
        "edge_single_day_15min": rule.generate_rule_plan(make_request(
            available_days_per_week=1,
            available_minutes_per_day=15,
        )),
    })))

    # 小函数矩阵：topic 推断、清洗、时长
    helper_inputs_topic = [
        ("高等数学重点复习积分与极限", []),
        ("我要准备考研英语冲刺", []),
        ("  高数   复习  ", []),
        ("还有14天完成操作系统实验报告", []),
        ("", ["定积分", "微分方程", "级数", "多重积分"]),
    ]
    dump(out_dir, "domain_helpers.json", normalize(to_jsonable({
        "infer_plan_kind": {
            text: rule.infer_plan_kind(text)
            for text in ["准备英语六级", "写课程论文报告", "复习高等数学", "准备 IELTS speaking"]
        },
        "infer_topic": {
            f"{goal}||{'/'.join(wp)}": rule.infer_topic(goal, wp)
            for goal, wp in helper_inputs_topic
        },
        "cleanup_topic": {
            text: rule.cleanup_topic(text)
            for text in ["我要复习高数还有14天", "每天60分钟考研英语", "本周完成实验报告", "想要准备期末考试"]
        },
        "short_goal": {
            text: rule.short_goal(text)
            for text in ["", "   ", "短目标", "这是一个非常非常长的学习目标用来验证超过二十四字符时会被截断并加上省略号"]
        },
        "duration": {
            f"{daily}*{ratio}": rule.duration(daily, ratio)
            for daily, ratio in [(90, 0.4), (25, 0.35), (15, 0.5), (60, 0.05), (10, 0.9)]
        },
        "clamp_minutes": {
            f"{v}/{fb}/{up}": rule.clamp_minutes(v, fb, up)
            for v, fb, up in [("abc", 30, 90), (None, 30, 90), (150, 30, 90), (-5, 30, 90), ("45", 30, 90)]
        },
        "coerce_task_type": {
            str(v): rule.coerce_task_type(v)
            for v in ["learn", "practice", "review", "mock_exam", "exam", None, "", " Learn "]
        },
        "clean_text": {
            str(v): rule.clean_text(v)
            for v in ["  多处\t空白\n混排  ", None, 123, ""]
        },
    })))

    # 积木计划：默认偏好 / 替换偏好（影响 selectedIndex）/ 时间约束 / 资料命中
    block_default = block.build_block_plan(make_request(), [])
    block_preferred = block.build_block_plan(
        make_request(preferences=["先做题找问题", "题练结合", "考前冲刺", "时间约束：晚上只有 30 分钟"]),
        [],
    )
    block_evidence = block.build_block_plan(
        make_request(),
        ["资料命中[高数讲义]: 积分的换元法是本次考试重点", "普通检索片段"],
    )
    dump(out_dir, "domain_block_plan.json", normalize(to_jsonable({
        "default": block_default,
        "preferred": block_preferred,
        "evidence": block_evidence,
        "expand_default": block.expand_to_weekly_plan(block_default, make_request()),
        "expand_alternate": block.expand_to_weekly_plan(
            block_default.model_copy(update={
                "blocks": [
                    b.model_copy(update={"selectedIndex": 1}) for b in block_default.blocks
                ]
            }),
            make_request(),
        ),
        "expand_single_day": block.expand_to_weekly_plan(
            block_default, make_request(available_days_per_week=1)
        ),
    })))


# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="baseline 输出目录（SynapseNext/baseline）")
    args = parser.parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    _tmp = setup_env()  # 保持引用，进程结束时自动清理

    import fastapi
    from fastapi.testclient import TestClient

    from app.core.config import get_settings
    from app.main import app

    api = get_settings().api_v1_prefix

    meta = {
        "python": sys.version.split()[0],
        "fastapi": fastapi.__version__,
        "old_repo": str(OLD_REPO),
        "api_prefix": api,
        "note": "假 Key / Mock LLM / 临时数据目录；uuid 与时间戳已归一化",
    }
    (out_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    (out_dir / "openapi.json").write_text(
        json.dumps(app.openapi(), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print("  wrote openapi.json")

    with TestClient(app) as client:
        capture_http(client, api, out_dir)
        capture_fake(client, api, out_dir)
    capture_domain(out_dir)

    # Windows 上 SQLite 引擎持有文件句柄，先释放再让临时目录清理
    engine_module = sys.modules.get("db.engine")
    engine = getattr(engine_module, "_engine", None) if engine_module else None
    if engine is not None:
        engine.dispose()
        engine_module._engine = None

    print("baseline capture done.")


if __name__ == "__main__":
    main()
