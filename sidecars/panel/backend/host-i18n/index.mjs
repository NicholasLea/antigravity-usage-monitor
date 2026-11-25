/**
 * @fileoverview Antigravity 宿主多语言子系统统一门面 (`backend/host-i18n/index.mjs`)。
 *
 * 主程序其余模块（`window-bridge.mjs`、`api-actions.mjs`）仅通过本门面与宿主翻译子系统交互，
 * 保持极薄的集成边界与完整可剥离性。
 */

import {
  HOST_I18N_DEFAULT_DEPTH,
  HOST_I18N_OFF_LOCALE,
  normalizeHostI18nDepth,
  normalizeHostI18nLocale,
} from '../../shared/host-i18n-protocol.mjs';
import { createHostI18nPackManager } from './pack-manager.mjs';
import {
  createHostI18nApplyExpression,
  createHostI18nCollectExpression,
  createHostI18nDisposeExpression,
  createHostI18nHeartbeatExpression,
} from './runtime-translator.mjs';

export {
  HOST_I18N_DEFAULT_DEPTH,
  HOST_I18N_OFF_LOCALE,
  createHostI18nApplyExpression,
  createHostI18nCollectExpression,
  createHostI18nDisposeExpression,
  createHostI18nHeartbeatExpression,
  createHostI18nPackManager,
  normalizeHostI18nDepth,
  normalizeHostI18nLocale,
};

let defaultHostI18nManager = null;

/**
 * 获取进程级默认宿主语言包管理器单例。
 */
export function getDefaultHostI18nManager() {
  if (!defaultHostI18nManager) {
    defaultHostI18nManager = createHostI18nPackManager();
  }
  return defaultHostI18nManager;
}

/**
 * 供 `window-bridge.mjs` 读取当前宿主翻译是否激活及按需下发描述。
 */
export function getHostI18nBridgeDescriptor() {
  return getDefaultHostI18nManager().getActiveBridgeDescriptor();
}

/**
 * 判断宿主语言翻译当前是否处于激活状态（用于独立保活 CDP 调试端口）。
 *
 * @returns {boolean}
 */
export function isHostI18nActiveForBridge() {
  return Boolean(getHostI18nBridgeDescriptor()?.active);
}

/**
 * 处理 `GET /api/host-i18n`：返回当前状态、已安装包与远端语言清单（必要时静默拉取缓存清单）。
 *
 * @param {{ bridgeStatus?: object|null, manager?: ReturnType<typeof createHostI18nPackManager> }} [options]
 */
export async function handleHostI18nGetRequest({ bridgeStatus = null, manager = null } = {}) {
  const mgr = manager || getDefaultHostI18nManager();
  const manifestResult = await mgr.refreshManifest({ force: false });
  return {
    ok: true,
    ...mgr.getStatusSnapshot({ manifestResult, bridgeStatus }),
  };
}

/**
 * 处理 `POST /api/host-i18n` 控制指令：
 * - `refresh_manifest`：强制刷新仓库语言包清单
 * - `select`：选择语言（未下载时自动拉取并校验 SHA-256 后生效，传 `'off'` 即关闭并还原）
 * - `set_depth`：在 `'light'` / `'deep'` 间零网络热切换
 * - `install` / `update`：显式下载或更新指定语言包
 * - `remove`：删除指定语言的本地缓存包
 * - `collect_untranslated`：按需采集当前打开宿主页面中未翻译的英文 UI 短语
 *
 * @param {object} body
 * @param {{
 *   bridgeStatus?: object|null,
 *   onChanged?: (() => Promise<any>|any)|null,
 *   collectFromTargets?: (() => Promise<{ targets: number, items: Array<{ text: string, kind: string, count: number }> }>)|null,
 *   manager?: ReturnType<typeof createHostI18nPackManager>|null,
 * }} [options]
 */
export async function handleHostI18nPostAction(
  body = {},
  { bridgeStatus = null, onChanged = null, collectFromTargets = null, manager = null } = {}
) {
  const mgr = manager || getDefaultHostI18nManager();
  const action = String(body?.action || '').trim().toLowerCase();

  try {
    if (action === 'refresh_manifest') {
      const manifestResult = await mgr.refreshManifest({ force: true });
      return {
        status: 200,
        payload: {
          ok: manifestResult.ok,
          ...(manifestResult.error ? { error: manifestResult.error } : {}),
          ...mgr.getStatusSnapshot({ manifestResult, bridgeStatus }),
        },
      };
    }

    if (action === 'select') {
      const res = await mgr.selectLanguage({
        locale: body?.locale,
        depth: body?.depth,
      });
      await Promise.resolve(onChanged?.()).catch(() => {});
      return {
        status: 200,
        payload: {
          ok: true,
          downloaded: Boolean(res.downloaded),
          ...mgr.getStatusSnapshot({ bridgeStatus }),
        },
      };
    }

    if (action === 'set_depth') {
      mgr.setDepth(body?.depth);
      await Promise.resolve(onChanged?.()).catch(() => {});
      return {
        status: 200,
        payload: {
          ok: true,
          ...mgr.getStatusSnapshot({ bridgeStatus }),
        },
      };
    }

    if (action === 'install' || action === 'update') {
      const res = await mgr.installPack(body?.locale, { forceManifestRefresh: true });
      const cur = mgr.loadState();
      if (res.updated !== false && cur.locale === res.locale) {
        await Promise.resolve(onChanged?.()).catch(() => {});
      }
      return {
        status: 200,
        payload: {
          ok: true,
          updated: res.updated !== false,
          alreadyUpToDate: Boolean(res.alreadyUpToDate),
          installed: res,
          ...mgr.getStatusSnapshot({ bridgeStatus }),
        },
      };
    }

    if (action === 'remove') {
      const res = mgr.removePack(body?.locale);
      await Promise.resolve(onChanged?.()).catch(() => {});
      return {
        status: res.ok ? 200 : 400,
        payload: {
          ok: res.ok,
          ...(res.error ? { error: res.error } : {}),
          ...mgr.getStatusSnapshot({ bridgeStatus }),
        },
      };
    }

    if (action === 'collect_untranslated') {
      if (typeof collectFromTargets !== 'function') {
        return {
          status: 400,
          payload: { ok: false, error: 'collector_unavailable', count: 0, items: [], template: { base: {} } },
        };
      }
      const collected = await collectFromTargets();
      const items = Array.isArray(collected?.items) ? collected.items : [];
      const templateBase = {};
      for (const item of items) {
        if (item?.text) templateBase[item.text] = '';
      }
      return {
        status: 200,
        payload: {
          ok: true,
          targets: Number(collected?.targets || 0),
          count: items.length,
          items,
          template: { base: templateBase },
        },
      };
    }

    return {
      status: 400,
      payload: { ok: false, error: `Unknown host-i18n action: ${action || '(empty)'}` },
    };
  } catch (err) {
    return {
      status: 500,
      payload: {
        ok: false,
        error: err?.message || 'Host I18n action failed',
        ...mgr.getStatusSnapshot({ bridgeStatus }),
      },
    };
  }
}
