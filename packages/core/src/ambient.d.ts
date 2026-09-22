/**
 * 最小环境声明：core 不使用 DOM lib（边界规则），
 * 但 TextDecoder / crypto.randomUUID 是 WebView 与 Node 18+ 均有的跨平台 API。
 * 小程序端若缺失由 P6 壳侧补 polyfill。
 */

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean });
  decode(input: Uint8Array): string;
}

declare const crypto: { randomUUID(): string };

/**
 * console 在 WebView / Node / 小程序 / Tauri 四种宿主中均存在，
 * 属于跨平台通用 API，不违反「core 不引用平台专属 API」的边界规则。
 */
declare const console: {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
