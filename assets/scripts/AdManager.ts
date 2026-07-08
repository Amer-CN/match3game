/**
 * AdManager — 微信激励视频广告单例
 *
 * 封装 wx.createRewardedVideoAd，提供 showRewardedAd(onReward, onFail?)。
 *
 * 降级策略（保证流程永远不卡）：
 *   以下任一情况 → 直接调用 onReward 发奖，并打印 '[Ad] 降级发奖'：
 *   1. wx 不存在（浏览器预览）
 *   2. wx.createRewardedVideoAd 不可用
 *   3. 广告 onError
 *   4. adUnitId 仍为占位值 'TODO_REPLACE_广告位ID'
 */

// WeChat mini-game 全局 API（非微信环境下不存在）
declare const wx: any;

export class AdManager {
    // ── 单例 ──────────────────────────────────
    private static _instance: AdManager | null = null;

    public static getInstance(): AdManager {
        if (!AdManager._instance) {
            AdManager._instance = new AdManager();
        }
        return AdManager._instance;
    }

    // ── 广告位 ID ─────────────────────────────
    /**
     * ⚠️ 上线前替换为真实广告位 ID
     * 目前为占位值，所有广告请求将走降级逻辑（直接发奖）。
     */
    private static readonly ADUNIT_ID = 'TODO_REPLACE_广告位ID';

    // ── 广告实例 ──────────────────────────────
    private videoAd: any = null;

    // ── 当前请求的回调 ────────────────────────
    private currentOnReward: (() => void) | null = null;
    private currentOnFail: (() => void) | null = null;

    // ── 是否有进行中的广告请求（防止重复触发） ──
    private pending = false;

    // ══════════════════════════════════════════════════════════════════════════
    //  构造（私有，单例）
    // ══════════════════════════════════════════════════════════════════════════

    private constructor() {
        this.initAd();
    }

    /**
     * 初始化广告实例。
     * 仅在「微信环境 + API 可用 + adUnitId 非占位」时创建，否则保持 null（降级模式）。
     * onLoad / onError / onClose 只绑定一次，通过成员变量传递回调，避免重复触发。
     */
    private initAd(): void {
        // ── 降级检查 1：wx 不存在（浏览器预览） ──
        if (typeof wx === 'undefined') {
            console.log('[Ad] wx 不存在（浏览器预览），降级模式');
            return;
        }

        // ── 降级检查 2：createRewardedVideoAd 不可用 ──
        if (typeof wx.createRewardedVideoAd !== 'function') {
            console.log('[Ad] createRewardedVideoAd 不可用，降级模式');
            return;
        }

        // ── 降级检查 3：adUnitId 仍为占位值 ──
        if (AdManager.ADUNIT_ID === 'TODO_REPLACE_广告位ID') {
            console.log('[Ad] adUnitId 仍为占位值，降级模式');
            return;
        }

        try {
            this.videoAd = wx.createRewardedVideoAd({ adUnitId: AdManager.ADUNIT_ID });

            // 广告加载成功
            this.videoAd.onLoad(() => {
                console.log('[Ad] 广告加载成功 (onLoad)');
            });

            // 广告加载/展示失败 → 降级发奖
            this.videoAd.onError((err: any) => {
                console.error('[Ad] 广告 onError:', JSON.stringify(err));
                this.degrade();
            });

            // 广告关闭 → 判断是否完整观看
            this.videoAd.onClose((res: any) => {
                console.log('[Ad] 广告 onClose:', JSON.stringify(res));
                if (res && res.isEnded === true) {
                    // 完整看完 → 发奖
                    this.doReward();
                } else {
                    // 中途关闭 → 不发奖，走 onFail
                    this.doFail();
                }
            });

            console.log('[Ad] 广告实例创建成功，adUnitId =', AdManager.ADUNIT_ID);
        } catch (e) {
            console.error('[Ad] 创建广告实例异常:', e);
            this.videoAd = null;
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  公开接口
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * 展示激励视频广告。
     *
     * - 玩家【完整看完】(onClose res.isEnded === true) → 调用 onReward 发奖
     * - 玩家【中途关闭】→ 调用 onFail（可选）
     * - 降级情况（wx 不存在 / API 不可用 / onError / adUnitId 占位）→ 直接调用 onReward
     *
     * @param onReward 完整看完或降级时的发奖回调
     * @param onFail   中途关闭时的回调（可选，不传则什么都不做）
     */
    public showRewardedAd(onReward: () => void, onFail?: () => void): void {
        // 防止重复调用（广告展示期间用户无法再次触发）
        if (this.pending) {
            console.warn('[Ad] 已有广告请求进行中，忽略本次调用');
            return;
        }

        this.pending = true;
        this.currentOnReward = onReward;
        this.currentOnFail = onFail ?? null;

        // ── 降级检查：广告实例不存在 ──
        // （wx 不存在 / API 不可用 / adUnitId 占位 / 创建异常 都会导致 videoAd 为 null）
        if (!this.videoAd) {
            this.degrade();
            return;
        }

        // ── 展示广告 ──
        console.log('[Ad] 调用 show()');
        this.videoAd.show().catch((err: any) => {
            // show 失败（通常是广告尚未加载完成），尝试 load 后再 show
            console.warn('[Ad] show 失败，尝试 load 后重试:', JSON.stringify(err));
            this.videoAd
                .load()
                .then(() => {
                    console.log('[Ad] load 成功，再次 show');
                    return this.videoAd.show();
                })
                .catch((err2: any) => {
                    console.error('[Ad] load + show 均失败:', JSON.stringify(err2));
                    this.degrade();
                });
        });
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  内部结算（pending 标志保证只触发一次）
    // ══════════════════════════════════════════════════════════════════════════

    /** 发奖（完整观看） */
    private doReward(): void {
        if (!this.pending) return;
        this.pending = false;
        console.log('[Ad] ✓ 发奖（完整观看）');
        const cb = this.currentOnReward;
        this.currentOnReward = null;
        this.currentOnFail = null;
        if (cb) cb();
    }

    /** 不发奖（中途关闭） */
    private doFail(): void {
        if (!this.pending) return;
        this.pending = false;
        console.log('[Ad] ✗ 未看完，不发奖');
        const cb = this.currentOnFail;
        this.currentOnReward = null;
        this.currentOnFail = null;
        if (cb) cb();
    }

    /** 降级发奖（直接调用 onReward） */
    private degrade(): void {
        if (!this.pending) return;
        this.pending = false;
        console.log('[Ad] 降级发奖');
        const cb = this.currentOnReward;
        this.currentOnReward = null;
        this.currentOnFail = null;
        if (cb) cb();
    }
}
