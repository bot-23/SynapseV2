import { useEffect } from 'react';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { getCore, getActiveUserId } from './services/synapse';
// 全局样式
import './app.scss';

/** 本地日期 YYYY-MM-DD（今天是否已提醒的判断依据）。 */
function todayKey(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 页内到期提醒：今天有到期复习时弹一次 toast，当天只提醒一次。
 * 刻意不接订阅消息、不引云开发 —— 全程本机、零配置。
 * 容错：任何异常都吞掉，绝不影响启动。
 */
function remindDueReviews(): void {
  try {
    const flag = `synapse.notified.${todayKey()}`;
    if (Taro.getStorageSync(flag)) {
      return;
    }
    const result = getCore().listReviews(getActiveUserId());
    const data = (result.data ?? {}) as Record<string, unknown>;
    const dueCount = Number(data['due_count'] ?? 0);
    if (!Number.isFinite(dueCount) || dueCount <= 0) {
      return;
    }
    Taro.setStorageSync(flag, '1');
    Taro.showToast({ title: `今天有 ${dueCount} 个知识点到期复习`, icon: 'none' });
  } catch (error) {
    console.error('[Synapse] 到期提醒失败（已忽略）', error);
  }
}

function App(props) {
  // 可以使用所有的 React Hooks
  useEffect(() => {});

  // 对应 onShow
  useDidShow(() => {
    remindDueReviews();
  });

  // 对应 onHide
  useDidHide(() => {});

  return props.children;
}

export default App;
