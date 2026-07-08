import { _decorator, Component, AudioClip, AudioSource, resources } from 'cc';
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
        specialLine: null, specialBomb: null, specialColorBomb: null,
    };
    private _combo: (AudioClip | null)[] = [null, null, null, null, null, null]; // 下标 1..5

    // 微信原生 InnerAudioContext（每个音效一个，复用）
    private _wxCtxs: Record<string, any> = {};
    private _wxCtxCombo: any[] = [null, null, null, null, null, null];
    private _isWeChat = false;

    onLoad() {
        AudioManager._inst = this;
        this._isWeChat = typeof wx !== 'undefined' && typeof wx.createInnerAudioContext === 'function';

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
        const clip = this._clips[name];
        if (!clip) return;

        if (this._isWeChat && this._wxCtxs[name]) {
            // 微信原生播放
            const ctx = this._wxCtxs[name];
            ctx.stop();
            ctx.play();
        } else if (this._src) {
            // Cocos AudioSource 播放（开发者工具/浏览器）
            this._src.clip = clip;
            this._src.volume = this.volume;
            this._src.play();
        }
    }

    playClick() { this._play('click'); }
    playSwap()  { this._play('swap'); }
    playMatch() { this._play('match'); }
    playFall()  { this._play('fall'); }
    playWin()   { this._play('win'); }
    playLose()  { this._play('lose'); }

    // 特效音效（无专属音效时降级到 match/win）
    playSpecialLine(): void {
        if (this._clips['specialLine']) this._play('specialLine');
        else this._play('match'); // TODO: 接入专属线消音效
    }
    playSpecialBomb(): void {
        if (this._clips['specialBomb']) this._play('specialBomb');
        else this._play('match'); // TODO: 接入专属炸弹音效
    }
    playSpecialColorBomb(): void {
        if (this._clips['specialColorBomb']) this._play('specialColorBomb');
        else this._play('win'); // TODO: 接入专属彩球音效
    }

    // 连击第 n 段（n 从 1 起）：音调随 n 升高；缺档往下取最近，全缺退回 match
    playCombo(n: number): void {
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
}
