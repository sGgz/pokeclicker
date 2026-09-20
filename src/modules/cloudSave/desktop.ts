export interface DesktopResult {
    ok: boolean;
    message?: string;
}

export interface DesktopBridge {
    version: 1;
    cloudRequest(input: { path: string; method: 'GET' | 'PUT' | 'POST'; body?: string }): Promise<{
        status: number;
        body: string;
        retryAfter?: string;
    }>;
    login(): Promise<DesktopResult>;
    onBeforeClose(callback: () => Promise<DesktopResult>): void;
}

declare global {
    interface Window {
        pokeclickerDesktop?: DesktopBridge;
    }
}

export function desktopBridge(): DesktopBridge | undefined {
    const bridge = window.pokeclickerDesktop;
    return bridge?.version === 1 ? bridge : undefined;
}
