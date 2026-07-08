import { _decorator, Component } from 'cc';
const { ccclass, property } = _decorator;

type HapticLevel = 'light' | 'medium' | 'heavy';

@ccclass('VibrateManager')
export class VibrateManager extends Component {
    private static _inst: VibrateManager | null = null;
    public static get inst() { return VibrateManager._inst; }

    @property vibrateEnabled: boolean = true;   // 总开关（接设置里的"震动"选项，避开 Component.enabled 撞名）
    @property cooldownMs: number = 80;   // 节流：两次震动最小间隔，防连锁狂震

    private _last = 0;
    private _wx: any = (globalThis as any).wx || null;
    private _tt: any = (globalThis as any).tt || null;

    onLoad() { VibrateManager._inst = this; }
    onDestroy() { if (VibrateManager._inst === this) VibrateManager._inst = null; }

    setVibrateEnabled(on: boolean) { this.vibrateEnabled = on; }
    getVibrateEnabled() { return this.vibrateEnabled; }

    private _canFire(): boolean {
        if (!this.vibrateEnabled) return false;
        const now = Date.now();
        if (now - this._last < this.cooldownMs) return false;
        this._last = now;
        return true;
    }

    // 短震：type 控制强弱（iOS 明显，部分安卓忽略 type 只出固定短震）
    short(level: HapticLevel = 'light') {
        if (!this._canFire()) return;
        try {
            if (this._wx?.vibrateShort) this._wx.vibrateShort({ type: level });
            else if (this._tt?.vibrateShort) this._tt.vibrateShort({ type: level });
        } catch (e) { /* 真机不支持则静默，不报错 */ }
    }

    // 长震：约 400ms，用于过关/失败等重反馈
    long() {
        if (!this._canFire()) return;
        try {
            if (this._wx?.vibrateLong) this._wx.vibrateLong({});
            else if (this._tt?.vibrateLong) this._tt.vibrateLong({});
        } catch (e) { /* no-op */ }
    }

    // 语义化封装
    light()  { this.short('light'); }
    medium() { this.short('medium'); }
    heavy()  { this.short('heavy'); }
}
