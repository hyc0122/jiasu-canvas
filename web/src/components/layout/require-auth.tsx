import { useEffect, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { WorkspaceBootSplash } from "@/components/layout/workspace-boot-splash";
import { useUserStore } from "@/stores/use-user-store";

export { WorkspaceBootSplash as AuthSplash } from "@/components/layout/workspace-boot-splash";

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

export function RequireAuth({ children }: { children: ReactNode }) {
    const location = useLocation();
    const hydrated = useUserStore((state) => state.hydrated);
    const sessionChecked = useUserStore((state) => state.sessionChecked);
    const accessToken = useUserStore((state) => state.accessToken);
    const user = useUserStore((state) => state.user);
    useRestoreSession();

    if (!hydrated || !sessionChecked) return <WorkspaceBootSplash />;
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
    useRestoreSession();

    if (!hydrated || !sessionChecked) return <WorkspaceBootSplash />;
    if (accessToken && user) return <Navigate to={from} replace />;
    return children;
}
