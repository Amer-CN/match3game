/**
 * GameClubEntry — 微信游戏圈入口按钮
 *
 * 封装 wx.createGameClubButton，在主界面 / 结算页显示游戏圈入口。
 * 非微信环境（浏览器预览、wx 或 API 不存在）降级：不创建、不报错。
 *
 * 坐标系说明：
 *   wx.createGameClubButton 的 style.left/top 使用屏幕逻辑像素，
 *   需要从 Cocos 设计分辨率换算。
 */

// WeChat mini-game 全局 API（非微信环境下不存在）
declare const wx: any;

export class GameClubEntry {
    // ── 广告实例 ──────────────────────────────
    private button: any = null;

    // ── 当前可见状态 ──────────────────────────
    private _visible = false;

    // ── 布局参数（设计分辨率） ────────────────
    private canvasW: number;
    private canvasH: number;
    private topInset: number;
    private hudHeight: number;

    // ══════════════════════════════════════════════════════════════════════════
    //  构造
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @param canvasW   设计分辨率宽（如 720）
     * @param canvasH   设计分辨率高（如 1280）
     * @param topInset  顶部安全边距（设计坐标，含胶囊避让）
     * @param hudHeight HUD 高度（设计坐标）
     */
    constructor(canvasW: number, canvasH: number, topInset: number, hudHeight: number) {
        this.canvasW = canvasW;
        this.canvasH = canvasH;
        this.topInset = topInset;
        this.hudHeight = hudHeight;
        this.createButton();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  创建按钮
    // ══════════════════════════════════════════════════════════════════════════

    private createButton(): void {
        // ── 降级检查 1：wx 不存在 ──
        if (typeof wx === 'undefined') {
            console.log('[GameClub] 非微信环境，跳过');
            return;
        }

        // ── 降级检查 2：createGameClubButton 不可用 ──
        if (typeof wx.createGameClubButton !== 'function') {
            console.log('[GameClub] wx.createGameClubButton 不可用，跳过');
            return;
        }

        try {
            // ── 获取窗口尺寸（屏幕逻辑像素） ──
            let winW = 0;
            let winH = 0;
            try {
                if (wx.getWindowInfo) {
                    const info = wx.getWindowInfo();
                    winW = info.windowWidth;
                    winH = info.windowHeight;
                } else if (wx.getSystemInfoSync) {
                    const info = wx.getSystemInfoSync();
                    winW = info.windowWidth;
                    winH = info.windowHeight;
                }
            } catch (e) {
                // ignore
            }

            winW = this.safeNum(winW, 0);
            winH = this.safeNum(winH, 0);
            if (winW <= 0 || winH <= 0) {
                console.warn('[GameClub] 无法获取窗口尺寸，跳过');
                return;
            }

            // ── 设计分辨率 → 屏幕逻辑像素 换算 ──
            const designW = this.safeNum(this.canvasW, 720);
            const designH = this.safeNum(this.canvasH, 1280);
            const scaleY = winH / designH;

            // ── 按钮尺寸（屏幕逻辑像素） ──
            const btnWidth = 90;
            const btnHeight = 34;
            const gap = 10; // HUD 底部到按钮的间距（设计坐标）

            // ── 位置计算 ──
            // top: topInset + HUD_HEIGHT + gap（设计坐标）→ 换算到屏幕像素
            const designTop = this.safeNum(this.topInset, 100) + this.safeNum(this.hudHeight, 64) + gap;
            const screenTop = designTop * scaleY;

            // right: 距右边缘 16px（屏幕像素）
            const rightMargin = 16;
            const screenLeft = winW - btnWidth - rightMargin;

            // ── NaN 最终保护 ──
            if (!this.isValidNum(screenTop) || !this.isValidNum(screenLeft)) {
                console.warn('[GameClub] 坐标计算异常，跳过', { screenTop, screenLeft });
                return;
            }

            console.log(
                `[GameClub] 创建按钮: screenLeft=${screenLeft.toFixed(1)}, ` +
                `screenTop=${screenTop.toFixed(1)}, ` +
                `winW=${winW}, winH=${winH}, scaleY=${scaleY.toFixed(3)}`,
            );

            this.button = wx.createGameClubButton({
                type: 'text',
                text: '游戏圈',
                style: {
                    left: screenLeft,
                    top: screenTop,
                    width: btnWidth,
                    height: btnHeight,
                    color: '#ffffff',
                    textAlign: 'center',
                    fontSize: 15,
                    borderRadius: 17,
                    backgroundColor: '#2ecc71',
                    borderColor: '#27ae60',
                    borderWidth: 1,
                    lineHeight: btnHeight,
                },
            });

            // 按钮创建后默认可见，先隐藏（等待 GameManager 控制显隐）
            this.button.hide();
            this._visible = false;

            // 点击回调（微信会自动跳转游戏圈，这里仅做日志）
            this.button.onTap(() => {
                console.log('[GameClub] 游戏圈按钮被点击');
            });

            console.log('[GameClub] 游戏圈按钮创建成功');
        } catch (e) {
            console.error('[GameClub] 创建按钮异常:', e);
            this.button = null;
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  公开接口
    // ══════════════════════════════════════════════════════════════════════════

    /** 显示游戏圈按钮 */
    public show(): void {
        if (!this.button) return;
        if (this._visible) return; // 已可见，不重复
        this.button.show();
        this._visible = true;
        console.log('[GameClub] show()');
    }

    /** 隐藏游戏圈按钮 */
    public hide(): void {
        if (!this.button) return;
        if (!this._visible) return; // 已隐藏，不重复
        this.button.hide();
        this._visible = false;
        console.log('[GameClub] hide()');
    }

    /** 销毁按钮 */
    public destroy(): void {
        if (this.button) {
            try {
                this.button.destroy();
            } catch (e) {
                // ignore
            }
            this.button = null;
            this._visible = false;
        }
    }

    /**
     * 窗口尺寸变化时重新定位（销毁旧按钮、用新尺寸重建）。
     * @param canvasW   新的设计分辨率宽
     * @param canvasH   新的设计分辨率高
     * @param topInset  新的顶部安全边距
     * @param hudHeight HUD 高度
     */
    public reposition(canvasW: number, canvasH: number, topInset: number, hudHeight: number): void {
        this.canvasW = canvasW;
        this.canvasH = canvasH;
        this.topInset = topInset;
        this.hudHeight = hudHeight;

        // 记录旧状态，重建后恢复
        const wasVisible = this._visible;
        this.destroy();
        this.createButton();
        if (wasVisible) {
            this.show();
        }
    }

    /** 按钮是否已成功创建 */
    public get isAvailable(): boolean {
        return this.button !== null;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  NaN 安全工具
    // ══════════════════════════════════════════════════════════════════════════

    private isValidNum(v: number): boolean {
        return typeof v === 'number' && !isNaN(v) && isFinite(v);
    }

    private safeNum(v: number, fallback: number): number {
        return this.isValidNum(v) ? v : fallback;
    }
}
