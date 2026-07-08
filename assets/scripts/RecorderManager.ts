/**
 * RecorderManager — 抖音录屏单例
 *
 * 封装 tt.getGameRecorderManager()，提供 start/stop/onStart/onStop。
 *
 * 降级策略（和 AdManager 一致，保证流程不卡）：
 *   以下任一情况 → 降级跳过，不报错：
 *   1. tt 不存在（浏览器 / 微信预览）
 *   2. tt.getGameRecorderManager 不可用
 *
 * Android/iOS 差异处理：
 *   stop() 后加 500ms 延迟才允许下一次 start()，
 *   否则安卓会覆盖上一段 / start 不执行。
 */

// 抖音小游戏全局 API（非抖音环境下不存在）
declare const tt: any;

type StartCallback = () => void;
type StopCallback = (videoPath: string) => void;
type ErrorCallback = (err: any) => void;

export class RecorderManager {
    // ── 单例 ──────────────────────────────────
    private static _instance: RecorderManager | null = null;

    public static getInstance(): RecorderManager {
        if (!RecorderManager._instance) {
            RecorderManager._instance = new RecorderManager();
        }
        return RecorderManager._instance;
    }

    // ── 录屏实例 ──────────────────────────────
    private recorder: any = null;

    // ── 状态 ──────────────────────────────────
    private isRecording = false;

    /** stop() 后的冷却期，防止安卓立刻 start 覆盖上一段 */
    private coolingDown = false;
    private static readonly COOLDOWN_MS = 500;

    // ── 回调 ──────────────────────────────────
    private _onStart: StartCallback | null = null;
    private _onStop: StopCallback | null = null;
    private _onError: ErrorCallback | null = null;

    // ── 最后一次录屏的 videoPath ──────────────
    private _lastVideoPath: string | null = null;

    // ══════════════════════════════════════════════════════════════════════════
    //  构造（私有，单例）
    // ══════════════════════════════════════════════════════════════════════════

    private constructor() {
        this.initRecorder();
    }

    /**
     * 初始化录屏实例。
     * 仅在「抖音环境 + API 可用」时创建，否则保持 null（降级模式）。
     */
    private initRecorder(): void {
        // ── 降级检查 1：tt 不存在 ──
        if (typeof tt === 'undefined') {
            console.log('[Recorder] tt 不存在（非抖音环境），降级跳过');
            return;
        }

        // ── 降级检查 2：getGameRecorderManager 不可用 ──
        if (typeof tt.getGameRecorderManager !== 'function') {
            console.log('[Recorder] tt.getGameRecorderManager 不可用，降级跳过');
            return;
        }

        try {
            this.recorder = tt.getGameRecorderManager();

            // 录屏开始
            this.recorder.onStart(() => {
                console.log('[Recorder] onStart — 录屏已开始');
                this.isRecording = true;
                if (this._onStart) this._onStart();
            });

            // 录屏结束（拿到 videoPath）
            this.recorder.onStop((res: any) => {
                console.log('[Recorder] onStop — 录屏已结束:', JSON.stringify(res));
                this.isRecording = false;

                const videoPath = (res && typeof res.videoPath === 'string') ? res.videoPath : '';
                if (videoPath) {
                    this._lastVideoPath = videoPath;
                    console.log('[Recorder] videoPath:', videoPath);
                }

                // 进入冷却期（安卓需要延迟才能下一次 start）
                this.startCooldown();

                if (this._onStop) this._onStop(videoPath);
            });

            // 录屏错误
            this.recorder.onError((err: any) => {
                console.error('[Recorder] onError:', JSON.stringify(err));
                this.isRecording = false;
                this.startCooldown();
                if (this._onError) this._onError(err);
            });

            console.log('[Recorder] 录屏实例创建成功');
        } catch (e) {
            console.error('[Recorder] 创建录屏实例异常:', e);
            this.recorder = null;
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  公开接口
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * 开始录屏。
     * @param duration 录屏时长（秒），抖音最大 300 秒
     */
    public start(duration: number = 300): void {
        if (!this.recorder) {
            console.log('[Recorder] 降级模式，start 跳过');
            return;
        }

        if (this.isRecording) {
            console.warn('[Recorder] 正在录屏中，忽略重复 start');
            return;
        }

        if (this.coolingDown) {
            console.warn('[Recorder] 冷却期内，忽略 start（安卓需要 500ms 间隔）');
            return;
        }

        try {
            console.log(`[Recorder] start() duration=${duration}s`);
            this.recorder.start({ duration });
        } catch (e) {
            console.error('[Recorder] start 异常:', e);
        }
    }

    /** 停止录屏，onStop 回调中拿到 videoPath */
    public stop(): void {
        if (!this.recorder) {
            console.log('[Recorder] 降级模式，stop 跳过');
            return;
        }

        if (!this.isRecording) {
            console.warn('[Recorder] 未在录屏，忽略 stop');
            return;
        }

        try {
            console.log('[Recorder] stop()');
            this.recorder.stop();
        } catch (e) {
            console.error('[Recorder] stop 异常:', e);
            this.isRecording = false;
            this.startCooldown();
        }
    }

    /**
     * 设置回调。
     * @param opts.onStart  录屏开始时调用
     * @param opts.onStop   录屏结束时调用，参数为 videoPath
     * @param opts.onError  录屏出错时调用
     */
    public on(opts: {
        onStart?: StartCallback;
        onStop?: StopCallback;
        onError?: ErrorCallback;
    }): void {
        if (opts.onStart !== undefined) this._onStart = opts.onStart;
        if (opts.onStop !== undefined) this._onStop = opts.onStop;
        if (opts.onError !== undefined) this._onError = opts.onError;
    }

    /** 是否正在录屏 */
    public get recording(): boolean {
        return this.isRecording;
    }

    /** 录屏实例是否可用 */
    public get isAvailable(): boolean {
        return this.recorder !== null;
    }

    /** 获取最后一次录屏的 videoPath */
    public get lastVideoPath(): string | null {
        return this._lastVideoPath;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  内部
    // ══════════════════════════════════════════════════════════════════════════

    /** 启动冷却计时器（安卓 stop 后立刻 start 会出问题） */
    private startCooldown(): void {
        this.coolingDown = true;
        setTimeout(() => {
            this.coolingDown = false;
            console.log('[Recorder] 冷却期结束，可以 start');
        }, RecorderManager.COOLDOWN_MS);
    }
}
