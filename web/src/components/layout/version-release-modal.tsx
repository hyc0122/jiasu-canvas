import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { App, Button, Modal, Progress, Tag, Timeline } from "antd";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useVersionCheck } from "@/hooks/use-version-check";
import { APP_VERSION } from "@/constant/env";

function getTagColor(type: string) {
    if (type === "新增" || type === "Added") return "green";
    if (type === "修复" || type === "Fixed") return "red";
    if (type === "调整" || type === "Changed") return "blue";
    if (type === "文档" || type === "Docs") return "purple";
    return "default";
}

function releaseTypeLabel(type: string, t: TFunction) {
    const key = ({ 新增: "added", 修复: "fixed", 调整: "changed", 优化: "optimized", 文档: "docs" } as Record<string, string>)[type];
    return key ? t(`version.types.${key}`) : type;
}

function isDesktopShell() {
    return typeof window !== "undefined" && Boolean(window.interfaceCanvasDesktop?.isElectron);
}

type VersionReleaseModalProps = {
    className?: string;
    style?: CSSProperties;
};

export function VersionReleaseModal({ className, style }: VersionReleaseModalProps) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const { open, setOpen, openReleaseModal, latestVersion, releases, checking, hasNewVersion, checkLatestRelease } = useVersionCheck();
    const desktop = isDesktopShell();
    const [desktopVersion, setDesktopVersion] = useState(APP_VERSION);
    const [hotChecking, setHotChecking] = useState(false);
    const [hotInstalling, setHotInstalling] = useState(false);
    const [hotProgress, setHotProgress] = useState(0);
    const [hotStatus, setHotStatus] = useState("");
    const [remoteHot, setRemoteHot] = useState<{ version?: string; notes?: string; available?: boolean; error?: string }>({});

    useEffect(() => {
        if (!desktop) return;
        void window.interfaceCanvasDesktop?.getAppVersion?.().then((version) => {
            if (version) setDesktopVersion(version);
        });
        const unsub = window.interfaceCanvasDesktop?.onUpdateProgress?.((payload) => {
            setHotProgress(payload.percent || 0);
            setHotStatus(payload.status || "");
        });
        return () => {
            unsub?.();
        };
    }, [desktop]);

    const displayVersion = desktop ? desktopVersion : APP_VERSION;
    const hotMarker = /^0\.18\.10(\b|$)/.test(String(displayVersion).replace(/^v/i, ""));

    const checkDesktopUpdate = async (showMessage = true) => {
        if (!window.interfaceCanvasDesktop?.checkForUpdate) {
            message.warning(t("version.desktopUnavailable"));
            return;
        }
        setHotChecking(true);
        try {
            const result = await window.interfaceCanvasDesktop.checkForUpdate();
            setRemoteHot({
                version: result.remoteVersion,
                notes: result.notes,
                available: Boolean(result.updateAvailable),
                error: result.error,
            });
            if (result.error && result.status === "error") {
                if (showMessage) message.error(result.error || t("version.updateFailed"));
                return;
            }
            if (result.updateAvailable) {
                if (showMessage) message.success(t("version.desktopUpdateAvailable", { version: result.remoteVersion }));
            } else if (result.status === "skipped") {
                if (showMessage) message.info(t("version.desktopPackagedOnly"));
            } else if (showMessage) {
                message.success(t("version.desktopUpToDate"));
            }
        } catch (error) {
            const text = error instanceof Error ? error.message : t("version.updateFailed");
            setRemoteHot({ error: text });
            if (showMessage) message.error(text);
        } finally {
            setHotChecking(false);
        }
    };

    const installDesktopUpdate = async () => {
        if (!window.interfaceCanvasDesktop?.downloadAndInstallUpdate) return;
        setHotInstalling(true);
        setHotProgress(0);
        try {
            const result = await window.interfaceCanvasDesktop.downloadAndInstallUpdate();
            if (!result?.ok) {
                message.error(result?.error || t("version.desktopInstallFailed"));
                setHotInstalling(false);
                return;
            }
            message.success(t("version.desktopRestarting"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("version.desktopInstallFailed"));
            setHotInstalling(false);
        }
    };

    return (
        <>
            <button
                type="button"
                className={className || "shrink-0 cursor-pointer text-xs font-medium text-stone-500 transition hover:text-stone-950 dark:text-stone-400 dark:hover:text-white"}
                style={style}
                onClick={() => {
                    openReleaseModal();
                    if (desktop) void checkDesktopUpdate(false);
                }}
                title={t("version.viewUpdates")}
            >
                <span className="relative inline-flex">
                    {displayVersion}
                    {hasNewVersion || remoteHot.available ? <span className="absolute -right-1.5 -top-1 size-1.5 rounded-full bg-green-500" /> : null}
                </span>
            </button>
            <Modal title={t("version.title")} open={open} width={680} centered footer={null} onCancel={() => setOpen(false)}>
                {hotMarker ? (
                    <div className="mb-4 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200">
                        {t("version.hotUpdateMarker", { version: displayVersion })}
                    </div>
                ) : null}
                <div className="mb-5 grid grid-cols-2 gap-3">
                    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="text-xs text-stone-500 dark:text-stone-400">{t("version.currentVersion")}</div>
                        <div className="mt-1 text-base font-semibold text-stone-950 dark:text-stone-100">{displayVersion}</div>
                    </div>
                    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="flex items-center justify-between gap-3">
                            <div className="text-xs text-stone-500 dark:text-stone-400">{t("version.latestVersion")}</div>
                            <button
                                type="button"
                                className="cursor-pointer bg-transparent p-0 text-[11px] font-normal text-stone-400 underline-offset-2 transition hover:text-stone-700 hover:underline dark:text-stone-500 dark:hover:text-stone-300"
                                onClick={() => {
                                    void checkLatestRelease(true);
                                    if (desktop) void checkDesktopUpdate(true);
                                }}
                            >
                                {t(checking || hotChecking ? "version.checking" : "version.checkUpdates")}
                            </button>
                        </div>
                        <div className="mt-1 text-base font-semibold text-stone-950 dark:text-stone-100">{remoteHot.version || latestVersion}</div>
                    </div>
                </div>

                {desktop ? (
                    <div className="mb-5 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="mb-2 text-sm font-semibold text-stone-950 dark:text-stone-100">{t("version.desktopHotUpdate")}</div>
                        {remoteHot.notes ? <p className="mb-3 text-xs text-stone-500 dark:text-stone-400">{remoteHot.notes}</p> : null}
                        {remoteHot.error ? <p className="mb-3 text-xs text-red-500">{remoteHot.error}</p> : null}
                        {(hotInstalling || hotProgress > 0) && hotStatus !== "up-to-date" ? (
                            <div className="mb-3">
                                <Progress percent={hotProgress} size="small" status={hotStatus === "error" ? "exception" : hotInstalling ? "active" : undefined} />
                                <div className="mt-1 text-[11px] text-stone-400">{hotStatus}</div>
                            </div>
                        ) : null}
                        <div className="flex flex-wrap gap-2">
                            <Button size="small" loading={hotChecking} onClick={() => void checkDesktopUpdate(true)}>
                                {t("version.checkUpdates")}
                            </Button>
                            <Button type="primary" size="small" disabled={!remoteHot.available} loading={hotInstalling} onClick={() => void installDesktopUpdate()}>
                                {t("version.desktopInstallAndRestart")}
                            </Button>
                        </div>
                    </div>
                ) : null}

                <div className="max-h-[56vh] overflow-y-auto pr-2">
                    <Timeline
                        items={releases.map((release) => ({
                            content: (
                                <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-sm font-semibold text-stone-950 dark:text-stone-100">{release.version === "Unreleased" ? t("version.unreleased") : release.version}</span>
                                        <span className="text-xs text-stone-500 dark:text-stone-400">{release.date}</span>
                                        <div className="flex min-w-0 items-center gap-1.5">
                                            {release.version === latestVersion ? <Tag color="green">{t("version.latest")}</Tag> : null}
                                            {release.version === APP_VERSION || release.version === displayVersion ? <Tag>{t("version.current")}</Tag> : null}
                                        </div>
                                    </div>
                                    <div className="mt-2 space-y-1.5">
                                        {release.items.map((item, index) => (
                                            <div key={`${release.version}-${index}`} className="flex items-start gap-2 text-sm leading-6 text-stone-700 dark:text-stone-300">
                                                <Tag color={getTagColor(item.type)} className="m-0 mt-0.5 shrink-0 whitespace-nowrap">
                                                    {releaseTypeLabel(item.type, t)}
                                                </Tag>
                                                <span className="min-w-0 flex-1">{item.content}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ),
                        }))}
                    />
                </div>
            </Modal>
        </>
    );
}
