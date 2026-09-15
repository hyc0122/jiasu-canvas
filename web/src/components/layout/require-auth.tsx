import { useEffect, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { WorkspaceBootSplash } from "@/components/layout/workspace-boot-splash";
import { useUserStore } from "@/stores/use-user-store";

export { WorkspaceBootSplash as AuthSplash } from "@/components/layout/workspace-boot-splash";

function isDesktopShell() {
    return typeof window !== "undefined" && Boolean(window.interfaceCanvasDesktop?.isElectron);
}

let appShellReadyNotified = false;

function notifyDesktopAppShellReady() {
    if (appShellReadyNotified) return;
    const notify = window.interfaceCanvasDesktop?.notifyAppShellReady;
    if (!notify) return;
    appShellReadyNotified = true;
    try {
        void notify();
    } catch {
        appShellReadyNotified = false;
    }
}

export function safeRedirect(from?: string) {
    if (!from || !from.startsWith("/") || from.startsWith("//") || from.startsWith("/login") || from.startsWith("/register") || from.startsWith("/user/reset")) return "/";
    return from;
}

function useRestoreSession() {
    const bootstrap = useUserStore((state) => state.bootstrap);
    const hydrated = useUserStore((state) => state.hydrated);
    useEffect(() => {
        if (!hydrated) return;
        void bootstrap();
    }, [bootstrap, hydrated]);
}

function useNotifyAppShellReady(ready: boolean) {
    useEffect(() => {
        if (!ready || !isDesktopShell()) return;
        notifyDesktopAppShellReady();
    }, [ready]);
}

function AuthGatePending() {
    if (isDesktopShell()) return null;
    return <WorkspaceBootSplash />;
}

export function RequireAuth({ children }: { children: ReactNode }) {
    const location = useLocation();
    const hydrated = useUserStore((state) => state.hydrated);
    const sessionChecked = useUserStore((state) => state.sessionChecked);
    const accessToken = useUserStore((state) => state.accessToken);
    const user = useUserStore((state) => state.user);
    const gateReady = hydrated && sessionChecked;
    useRestoreSession();
    useNotifyAppShellReady(gateReady);

    if (!gateReady) return <AuthGatePending />;
    if (!accessToken || !user) {
        return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
    }
    return children;
}

export function GuestOnly({ children }: { children: ReactNode }) {
    const location = useLocation();
    const hydrated = useUserStore((state) => state.hydrated);
    const sessionChecked = useUserStore((state) => state.sessionChecked);
    const accessToken = useUserStore((state) => state.accessToken);
    const user = useUserStore((state) => state.user);
    const from = safeRedirect((location.state as { from?: string } | null)?.from);
    const gateReady = hydrated && sessionChecked;
    useRestoreSession();
    useNotifyAppShellReady(gateReady);

    if (!gateReady) return <AuthGatePending />;
    if (accessToken && user) return <Navigate to={from} replace />;
    return children;
}
