import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

const PRIMARY = "#2F6BFF";
const OK = "#3dd6c6";
const STEP_MS = 700;

type StepState = "wait" | "now" | "done";

function GyroSpinner() {
    return (
        <svg className="boot-splash-spinner" viewBox="0 0 64 64" fill="none" aria-hidden="true">
            <ellipse className="boot-splash-spin" cx="32" cy="32" rx="26" ry="10" stroke="currentColor" strokeWidth="2" />
            <ellipse className="boot-splash-spin-rev" cx="32" cy="32" rx="10" ry="26" stroke="currentColor" strokeWidth="2" />
            <ellipse cx="32" cy="32" rx="22" ry="22" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1.2" />
            <circle cx="32" cy="32" r="3.5" fill="currentColor" />
        </svg>
    );
}

export function WorkspaceBootSplash() {
    const { t } = useTranslation();
    const labels = useMemo(
        () => [
            t("auth.splashStepEnv"),
            t("auth.splashStepSession"),
            t("auth.splashStepAgent"),
            t("auth.splashStepOpen"),
        ],
        [t],
    );
    const [activeIndex, setActiveIndex] = useState(0);

    useEffect(() => {
        const ensure = window.interfaceCanvasDesktop?.ensureCanvasAgentStarted;
        if (ensure) void ensure().catch(() => undefined);
    }, []);

    useEffect(() => {
        if (activeIndex >= labels.length - 1) return;
        const timer = window.setTimeout(() => setActiveIndex((value) => Math.min(value + 1, labels.length - 1)), STEP_MS);
        return () => window.clearTimeout(timer);
    }, [activeIndex, labels.length]);

    const percent = Math.min(96, 18 + activeIndex * 22 + 8);
    const steps: StepState[] = labels.map((_, index) => {
        if (index < activeIndex) return "done";
        if (index === activeIndex) return "now";
        return "wait";
    });

    const statusLabel = (state: StepState) => {
        if (state === "done") return t("auth.splashDone");
        if (state === "now") return t("auth.splashNow");
        return t("auth.splashWait");
    };

    return (
        <div className="flex h-dvh items-center justify-center bg-[#09090b] px-4 text-[#1a1d24]" role="status" aria-busy="true" aria-live="polite">
            <style>{`
              .boot-splash-spinner {
                width: 48px; height: 48px; flex-shrink: 0; color: ${PRIMARY};
                filter: drop-shadow(0 0 6px color-mix(in srgb, ${PRIMARY} 70%, transparent));
              }
              .boot-splash-spin { animation: boot-splash-spin 2s linear infinite; transform-origin: center; transform-box: fill-box; }
              .boot-splash-spin-rev { animation: boot-splash-spin-rev 2s linear infinite; transform-origin: center; transform-box: fill-box; }
              @keyframes boot-splash-spin { to { transform: rotate(360deg); } }
              @keyframes boot-splash-spin-rev { to { transform: rotate(-360deg); } }
              @media (prefers-reduced-motion: reduce) {
                .boot-splash-spin, .boot-splash-spin-rev { animation: none !important; }
              }
            `}</style>
            <div className="w-full max-w-[512px] overflow-hidden rounded-[14px] bg-white shadow-[0_24px_48px_rgba(16,24,40,0.32)]">
                <div className="flex h-11 items-center justify-between border-b border-[#e8ecf2] px-3.5 text-sm font-medium">
                    <span className="flex items-center">
                        <span className="mr-2 grid size-5 place-items-center rounded-full bg-[#1a1d24] text-[10px] text-white">▶</span>
                        {t("meta.title")}
                    </span>
                </div>
                <div className="p-6">
                    <div className="mb-4 flex items-center gap-4">
                        <GyroSpinner />
                        <div>
                            <h1 className="text-xl font-semibold tracking-tight text-[#1a1d24]">{t("auth.splashTitle")}</h1>
                            <p className="mt-0.5 text-xs text-[#6b7280]">{t("auth.splashSubtitle")}</p>
                        </div>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-[#e8ecf2]">
                        <i className="block h-full rounded-full transition-all duration-500" style={{ width: `${percent}%`, background: PRIMARY }} />
                    </div>
                    <ul className="mt-3 list-none p-0">
                        {labels.map((label, index) => {
                            const state = steps[index];
                            const isDone = state === "done";
                            const isNow = state === "now";
                            return (
                                <li
                                    key={label}
                                    className={`flex items-center justify-between border-t border-[#e8ecf2] py-2.5 text-sm ${isDone || isNow ? "text-[#1a1d24]" : "text-[#6b7280]"}`}
                                >
                                    <span className="flex items-center gap-2">
                                        <span
                                            className="grid size-4 place-items-center rounded-full text-[10px]"
                                            style={{
                                                border: isNow ? `2px solid ${PRIMARY}` : isDone ? `1px solid ${OK}` : "1px solid #e8ecf2",
                                                background: isDone ? OK : "transparent",
                                                color: isDone ? "#07090f" : "inherit",
                                            }}
                                        >
                                            {isDone ? "✓" : ""}
                                        </span>
                                        {label}
                                    </span>
                                    <span className="text-xs" style={{ color: isDone ? OK : isNow ? PRIMARY : "#6b7280" }}>
                                        {statusLabel(state)}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            </div>
        </div>
    );
}

export { WorkspaceBootSplash as AuthSplash };
