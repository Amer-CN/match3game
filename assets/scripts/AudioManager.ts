import { _decorator, Component, AudioClip, AudioSource, resources } from 'cc';
import { SaveManager } from './SaveManager';
const { ccclass } = _decorator;

// 微信小游戏全局 API
declare const wx: any;

@ccclass('AudioManager')
export class AudioManager extends Component {
    private static _inst: AudioManager | null = null;
    public static get inst(): AudioManager | null { return AudioManager._inst; }

    volume: number = 0.8;
    private _src!: AudioSource;
    private _clips: Record<string, AudioClip | null> = {
        click: null, swap: null, match: null, fall: null, win: null, lose: null,
        fx_line: null, fx_bomb: null, fx_colorbomb: null,
    };
    private _combo: (AudioClip | null)[] = [null, null, null, null, null, null]; // 下标 1..5

    // 微信原生 InnerAudioContext（每个音效一个，复用）
    private _wxCtxs: Record<string, any> = {};
    private _wxCtxCombo: any[] = [null, null, null, null, null, null];
    private _isWeChat = false;

    // R1: 静音总开关
    private _enabled = true;

    onLoad() {
        AudioManager._inst = this;
        this._isWeChat = typeof wx !== 'undefined' && typeof wx.createInnerAudioContext === 'function';

        // R1: 从存档读取音效开关
        try {
            this._enabled = SaveManager.inst.getSoundEnabled();
        } catch (e) {
            this._enabled = true; // 读不到就默认开
        }

        // 非微信环境才用 Cocos AudioSource
        if (!this._isWeChat) {
            this._src = this.getComponent(AudioSource) || this.addComponent(AudioSource);
            this._src.loop = false;
        }

        for (const name of Object.keys(this._clips)) {
            resources.load(`audio/${name}`, AudioClip, (e, c) => {
                if (!e && c) {
                    this._clips[name] = c;
                    if (this._isWeChat) this._createWxCtx(name, c);
                }
            });
        }
        for (let i = 1; i <= 5; i++) {
            resources.load(`audio/combo${i}`, AudioClip, (e, c) => {
                if (!e && c) {
                    this._combo[i] = c;
                    if (this._isWeChat) this._createWxCtxCombo(i, c);
                }
            });
        }
    }

    /** 用 AudioClip 的 nativeUrl 创建微信 InnerAudioContext */
    private _createWxCtx(name: string, clip: AudioClip): void {
        const src = clip.nativeUrl;
        if (!src) { console.warn(`[Audio] nativeUrl 为空: ${name}`); return; }
        const ctx = wx.createInnerAudioContext();
        ctx.src = src;
        ctx.volume = this.volume;
        ctx.obeyMuteSwitch = false; // 关键：iOS 静音模式下也能播放
        ctx.onError((r: any) => console.error('AUDIO_ERR', name, r.errCode, r.errMsg));
        this._wxCtxs[name] = ctx;
        console.log(`[Audio] wx ctx created: ${name} -> ${src}`);
    }

    private _createWxCtxCombo(idx: number, clip: AudioClip): void {
        const src = clip.nativeUrl;
        if (!src) { console.warn(`[Audio] nativeUrl 为空: combo${idx}`); return; }
        const ctx = wx.createInnerAudioContext();
        ctx.src = src;
        ctx.volume = this.volume;
        ctx.obeyMuteSwitch = false;
        ctx.onError((r: any) => console.error('AUDIO_ERR', `combo${idx}`, r.errCode, r.errMsg));
        this._wxCtxCombo[idx] = ctx;
        console.log(`[Audio] wx ctx created: combo${idx} -> ${src}`);
    }

    onDestroy() {
        if (AudioManager._inst === this) AudioManager._inst = null;
        if (this._isWeChat) {
            for (const k in this._wxCtxs) { try { this._wxCtxs[k]?.destroy(); } catch (e) { /* ignore */ } }
            for (let i = 1; i <= 5; i++) { try { this._wxCtxCombo[i]?.destroy(); } catch (e) { /* ignore */ } }
        }
    }

    private _play(name: string): void {
        if (!this._enabled) return; // R1: 静音守卫
        const clip = this._clips[name];
        if (!clip) return;

        if (this._isWeChat && this._wxCtxs[name]) {
            // 微信原生播放
            const ctx = this._wxCtxs[name];
            ctx.stop();
            ctx.volume = this.volume;
            ctx.play();
        } else if (this._src) {
            // Cocos AudioSource 播放（开发者工具/浏览器）
            this._src.clip = clip;
            this._src.volume = this.volume;
            this._src.play();
        }
    }

    /** T2: 带音量加成的播放（特效音用，volMult>1 提升音量） */
    private _playVol(name: string, volMult: number): void {
        if (!this._enabled) return;
        const clip = this._clips[name];
        if (!clip) return;
        const vol = Math.min(1, this.volume * volMult);
        if (this._isWeChat && this._wxCtxs[name]) {
            const ctx = this._wxCtxs[name];
            ctx.stop();
            ctx.volume = vol;
            ctx.play();
        } else if (this._src) {
            this._src.clip = clip;
            this._src.volume = vol;
            this._src.play();
        }
    }

    playClick() { this._play('click'); }
    playSwap()  { this._play('swap'); }
    playMatch() { this._play('match'); }
    playFall()  { this._play('fall'); }
    playWin()   { this._play('win'); }
    playLose()  { this._play('lose'); }

    // T2: 特效音效——专属 clip 优先 → 差异化降级（比普通消除更重/更亮） → match/win 兜底
    playSpecialLine(): void {
        try {
            if (this._clips['fx_line']) { this._playVol('fx_line', 1.15); return; }
            // 降级：combo3 单发（比普通 match 高一档）
            if (this._playComboClipVol(3, 1.15)) return;
            this._play('match'); // 最终兜底
        } catch (e) { try { this._play('match'); } catch (_) { /* ignore */ } }
    }
    playSpecialBomb(): void {
        if (!this._enabled) return;
        try {
            if (this._clips['fx_bomb']) { this._playVol('fx_bomb', 1.2); return; }
            // 降级：微信环境叠播 match+win 制造「轰」感；非微信走 combo1 低音
            if (this._isWeChat) {
                let played = false;
                if (this._wxCtxs['match']) {
                    try { this._wxCtxs['match'].stop(); this._wxCtxs['match'].volume = Math.min(1, this.volume * 1.2); this._wxCtxs['match'].play(); } catch (_) { /* ignore */ }
                    played = true;
                }
                if (this._wxCtxs['win']) {
                    try { this._wxCtxs['win'].stop(); this._wxCtxs['win'].volume = Math.min(1, this.volume * 1.2); this._wxCtxs['win'].play(); } catch (_) { /* ignore */ }
                    played = true;
                }
                if (played) return;
            }
            // 非微信或无 match/win：combo1 最低音
            if (this._playComboClipVol(1, 1.2)) return;
            this._play('match'); // 最终兜底
        } catch (e) { try { this._play('match'); } catch (_) { /* ignore */ } }
    }
    playSpecialColorBomb(): void {
        if (!this._enabled) return;
        try {
            if (this._clips['fx_colorbomb']) { this._playVol('fx_colorbomb', 1.2); return; }
            // 降级：combo1→3→5 上行三连音（拉开气势）
            if (this._isWeChat) {
                let any = false;
                [1, 3, 5].forEach((idx, i) => {
                    if (this._wxCtxCombo[idx]) {
                        any = true;
                        this.scheduleOnce(() => {
                            try {
                                this._wxCtxCombo[idx]?.stop();
                                this._wxCtxCombo[idx].volume = Math.min(1, this.volume * 1.2);
                                this._wxCtxCombo[idx]?.play();
                            } catch (_) { /* ignore */ }
                        }, i * 0.08);
                    }
                });
                if (any) return;
            } else {
                // 非微信：单 AudioSource 只能播一个，取最高 combo 模拟华丽感
                for (let i = 5; i >= 1; i--) {
                    if (this._combo[i]) { this._playComboClipVol(i, 1.2); return; }
                }
            }
            this._play('win'); // 最终兜底
        } catch (e) { try { this._play('win'); } catch (_) { /* ignore */ } }
    }

    /** 播放 combo 音效（按下标 1..5），返回是否成功播放 */
    private _playComboClip(idx: number): boolean {
        if (!this._enabled) return false; // R1: 静音守卫
        if (this._isWeChat && this._wxCtxCombo[idx]) {
            try { this._wxCtxCombo[idx].stop(); this._wxCtxCombo[idx].volume = this.volume; this._wxCtxCombo[idx].play(); } catch (e) { return false; }
            return true;
        }
        if (!this._isWeChat && this._combo[idx] && this._src) {
            this._src.clip = this._combo[idx];
            this._src.volume = this.volume;
            this._src.play();
            return true;
        }
        return false;
    }

    /** T2: 带音量加成的 combo 播放 */
    private _playComboClipVol(idx: number, volMult: number): boolean {
        if (!this._enabled) return false;
        const vol = Math.min(1, this.volume * volMult);
        if (this._isWeChat && this._wxCtxCombo[idx]) {
            try { this._wxCtxCombo[idx].stop(); this._wxCtxCombo[idx].volume = vol; this._wxCtxCombo[idx].play(); } catch (e) { return false; }
            return true;
        }
        if (!this._isWeChat && this._combo[idx] && this._src) {
            this._src.clip = this._combo[idx];
            this._src.volume = vol;
            this._src.play();
            return true;
        }
        return false;
    }

    // 连击第 n 段（n 从 1 起）：音调随 n 升高；缺档往下取最近，全缺退回 match
    playCombo(n: number): void {
        if (!this._enabled) return; // R1: 静音守卫
        const idx = Math.min(Math.max(n, 1), 5);

        if (this._isWeChat) {
            let ctx: any = null;
            for (let i = idx; i >= 1; i--) {
                if (this._wxCtxCombo[i]) { ctx = this._wxCtxCombo[i]; break; }
            }
            if (!ctx) ctx = this._wxCtxs['match'];
            if (ctx) {
                ctx.stop();
                ctx.play();
            }
        } else {
            let clip: AudioClip | null = null;
            for (let i = idx; i >= 1; i--) { if (this._combo[i]) { clip = this._combo[i]; break; } }
            if (!clip) clip = this._clips['match'];
            if (clip && this._src) {
                this._src.clip = clip;
                this._src.volume = this.volume;
                this._src.play();
            }
        }
    }

    // ── R1: 静音总开关 ─────────────────────────────

    /** 设置静音开关；关闭时停掉正在播放的音频 */
    setEnabled(on: boolean): void {
        this._enabled = (on === true);
        if (!this._enabled) {
            // 停掉正在播放的音频
            try {
                if (this._isWeChat) {
                    for (const k in this._wxCtxs) {
                        try { this._wxCtxs[k]?.stop(); } catch (e) { /* ignore */ }
                    }
                    for (let i = 1; i <= 5; i++) {
                        try { this._wxCtxCombo[i]?.stop(); } catch (e) { /* ignore */ }
                    }
                } else if (this._src) {
                    this._src.stop();
                }
            } catch (e) { /* ignore */ }
        }
        // 写入存档
        try { SaveManager.inst.setSoundEnabled(this._enabled); } catch (e) { /* ignore */ }
    }

    /** 获取当前静音开关状态 */
    getEnabled(): boolean {
        return this._enabled;
    }
}
