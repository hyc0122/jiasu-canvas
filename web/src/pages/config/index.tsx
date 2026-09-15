import { useTranslation } from "react-i18next";

import { AppConfigPanel } from "@/components/layout/app-config-modal";
import { APP_VERSION } from "@/constant/env";

export default function ConfigPage() {
    const { t } = useTranslation();
    const hotMarker = /^0\.18\.10(\b|$)/.test(String(APP_VERSION).replace(/^v/i, ""));

    return (
        <main className="h-full overflow-y-auto bg-background">
            <div className="mx-auto max-w-6xl px-6 py-6">
                <div className="mb-5">
                    <h1 className="text-xl font-semibold text-stone-950 dark:text-stone-100">{t("config.title")}</h1>
                    <p className="mt-1 text-sm text-stone-500">{t("config.description")}</p>
                    {hotMarker ? (
                        <p className="mt-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                            {t("version.hotUpdateMarker", { version: APP_VERSION })}
                        </p>
                    ) : null}
                </div>
                <AppConfigPanel />
            </div>
        </main>
    );
}
