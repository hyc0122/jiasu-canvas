import { useEffect, useMemo, useState } from "react";
import { App, Button, ConfigProvider, Form, Input, Modal, message as antdMessage, theme as antdTheme } from "antd";
import { Eye, EyeOff, Lock, Mail, Shield, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { safeRedirect } from "@/components/layout/require-auth";
import { changeAppLocale, type AppLocale } from "@/i18n";
import { confirmPasswordReset, sendEmailVerification, sendPasswordResetEmail } from "@/services/api/auth";
import { SHOW_INVITE_CODE } from "@/constant/env";
import { useUserStore } from "@/stores/use-user-store";

type LoginValues = { username: string; password: string };
type RegisterValues = { username: string; email: string; verification_code: string; password: string; confirmPassword: string; aff_code?: string };
type TwoFactorValues = { code: string };
type ResetValues = { email: string; token: string };

const loginTheme = {
    algorithm: antdTheme.darkAlgorithm,
    token: {
        colorPrimary: "#fafafa",
        colorTextLightSolid: "#111111",
        colorBgContainer: "rgba(255,255,255,0.06)",
        colorBorder: "rgba(255,255,255,0.08)",
        colorText: "rgba(255,255,255,0.92)",
        colorTextPlaceholder: "rgba(255,255,255,0.32)",
        borderRadius: 10,
        fontSize: 14,
    },
    components: {
        Button: { primaryShadow: "none" },
        Input: { activeShadow: "none" },
        Modal: {
            contentBg: "#121216",
            headerBg: "#121216",
            titleColor: "rgba(255,255,255,0.92)",
        },
    },
};

const fieldClass = "mb-4";
const inputClass = "h-11";
const BOOT_PRIMARY = "#2F6BFF";

function publicAsset(path: string) {
    const base = import.meta.env.BASE_URL || "/";
    const normalizedBase = base.endsWith("/") ? base : `${base}/`;
    return `${normalizedBase}${path.replace(/^\//, "")}`;
}

function fieldText(value: unknown) {
    return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function errorMessage(error: unknown, fallback: string) {
    if (error instanceof Error && fieldText(error.message)) return error.message;
    return fallback;
}

function toast(kind: "success" | "error", text: string) {
    antdMessage.open({ type: kind, content: text, duration: 4 });
}

function readRegisterEmail(form: { getFieldValue: (name: keyof RegisterValues) => unknown }) {
    const fromStore = fieldText(form.getFieldValue("email"));
    if (fromStore) return fromStore;
    const input = document.querySelector('form input[autocomplete="email"]') as HTMLInputElement | null;
    return fieldText(input?.value);
}

function parseResetDeepLink(pathname: string, search: string) {
    const params = new URLSearchParams(search);
    let email = fieldText(params.get("email"));
    let token = fieldText(params.get("token"));
    if ((!email || !token) && typeof window !== "undefined") {
        const hash = window.location.hash || "";
        const qIndex = hash.indexOf("?");
        if (qIndex >= 0) {
            const hashParams = new URLSearchParams(hash.slice(qIndex + 1));
            email = email || fieldText(hashParams.get("email"));
            token = token || fieldText(hashParams.get("token"));
        }
    }
    const isResetPath = pathname.includes("/user/reset") || pathname.endsWith("/reset");
    return { email, token, open: Boolean((email && token) || isResetPath) };
}

function sleep(ms: number) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function RadarSpinner() {
    return (
        <div className="boot-radar mx-auto mb-3" aria-hidden="true">
            <div className="boot-radar-ring" />
            <div className="boot-radar-ring-inner" />
            <div className="boot-radar-sweep" />
            <div className="boot-radar-needle" />
            <div className="boot-radar-dot" />
        </div>
    );
}

export default function LoginPage() {
    const { i18n, t } = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const mode = location.pathname.endsWith("/register") ? "register" : "login";
    const locationState = (location.state as { from?: string; registeredUsername?: string } | null) || {};
    const from = safeRedirect(locationState.from);
    const login = useUserStore((state) => state.login);
    const register = useUserStore((state) => state.register);
    const complete2fa = useUserStore((state) => state.complete2fa);
    const [loginForm] = Form.useForm<LoginValues>();
    const [registerForm] = Form.useForm<RegisterValues>();
    const [twoFactorForm] = Form.useForm<TwoFactorValues>();
    const [resetForm] = Form.useForm<ResetValues>();
    const [submitting, setSubmitting] = useState(false);
    const [sendingCode, setSendingCode] = useState(false);
    const [sendHint, setSendHint] = useState("");
    const [countdown, setCountdown] = useState(0);
    const [flowToken, setFlowToken] = useState("");
    const [booting, setBooting] = useState(false);
    const [bootPercent, setBootPercent] = useState(8);
    const [bootStatus, setBootStatus] = useState("");
    const [resetOpen, setResetOpen] = useState(false);
    const [resetStep, setResetStep] = useState<1 | 2 | 3>(1);
    const [resetSending, setResetSending] = useState(false);
    const [resetConfirming, setResetConfirming] = useState(false);
    const [newPassword, setNewPassword] = useState("");
    const locale = i18n.resolvedLanguage as AppLocale;
    const nextLocale = locale === "zh-CN" ? "en-US" : "zh-CN";
    const languageLabel = t("topNav.switchLanguage", { language: t(nextLocale === "zh-CN" ? "locale.zhCN" : "locale.enUS") });

    const bootStatuses = useMemo(() => [t("auth.bootPullConfig"), t("auth.bootSyncChannels"), t("auth.bootEnterWorkspace")], [t]);

    useEffect(() => {
        if (countdown <= 0) return;
        const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000);
        return () => window.clearTimeout(timer);
    }, [countdown]);

    useEffect(() => {
        setFlowToken("");
        twoFactorForm.resetFields();
    }, [mode, twoFactorForm]);

    useEffect(() => {
        const deep = parseResetDeepLink(location.pathname, location.search);
        if (!deep.open) return;
        setResetOpen(true);
        if (deep.email || deep.token) {
            resetForm.setFieldsValue({ email: deep.email, token: deep.token });
            setResetStep(deep.token ? 2 : 1);
        } else {
            setResetStep(1);
        }
    }, [location.pathname, location.search, resetForm]);

    const lastUsername = useUserStore((state) => state.lastUsername);
    const lastPassword = useUserStore((state) => state.lastPassword);

    useEffect(() => {
        let cancelled = false;
        const apply = (name?: string, password?: string) => {
            const next: { username?: string; password?: string } = {};
            const userValue = fieldText(name);
            const passValue = fieldText(password);
            if (userValue && !fieldText(loginForm.getFieldValue("username"))) next.username = userValue;
            if (passValue && !fieldText(loginForm.getFieldValue("password"))) next.password = passValue;
            if (next.username || next.password) loginForm.setFieldsValue(next);
        };
        apply(locationState.registeredUsername || lastUsername, lastPassword);
        void window.interfaceCanvasDesktop?.loadSession?.().then((session) => {
            if (!cancelled) apply(session?.username, session?.password);
        });
        return () => {
            cancelled = true;
        };
    }, [lastPassword, lastUsername, locationState.registeredUsername, loginForm]);

    const runBootThenNavigate = async () => {
        setBooting(true);
        setBootPercent(8);
        setBootStatus(bootStatuses[0] || t("auth.bootPullConfig"));
        const ensure = window.interfaceCanvasDesktop?.ensureCanvasAgentStarted;
        const agentPromise = ensure ? ensure().catch(() => undefined) : Promise.resolve(undefined);
        const stages = [
            { percent: 28, status: bootStatuses[0], wait: 700 },
            { percent: 52, status: bootStatuses[1], wait: 750 },
            { percent: 78, status: t("auth.bootStartingAgent"), wait: 800 },
            { percent: 94, status: bootStatuses[2], wait: 700 },
        ];
        for (const stage of stages) {
            setBootPercent(stage.percent);
            setBootStatus(stage.status);
            await sleep(stage.wait);
        }
        await Promise.race([agentPromise, sleep(900)]);
        setBootPercent(100);
        setBootStatus(bootStatuses[2] || t("auth.bootEnterWorkspace"));
        await sleep(350);
        navigate(from, { replace: true });
    };

    const handleLogin = async (values: LoginValues) => {
        setSubmitting(true);
        try {
            const result = await login(values.username, values.password);
            if (!result.ok) {
                setFlowToken(result.flowToken);
                return;
            }
            setBooting(true);
            setBootPercent(8);
            setBootStatus(bootStatuses[0] || t("auth.bootPullConfig"));
            toast("success", t("auth.loginSuccess"));
            await runBootThenNavigate();
        } catch (error) {
            toast("error", errorMessage(error, t("auth.requestFailed")));
        } finally {
            setSubmitting(false);
        }
    };

    const handleRegister = async (values: RegisterValues) => {
        setSubmitting(true);
        try {
            const username = fieldText(values.username);
            const email = fieldText(values.email);
            const verificationCode = fieldText(values.verification_code ?? registerForm.getFieldValue("verification_code"));
            if (!email) throw new Error(t("auth.emailRequired"));
            if (!/^\d{6}$/.test(verificationCode)) throw new Error(t("auth.codeRequired"));
            await register({
                username,
                password: values.password,
                email,
                verification_code: verificationCode,
                aff_code: fieldText(values.aff_code) || undefined,
            });
            toast("success", t("auth.registerSuccess"));
            navigate("/login", { replace: true, state: { from, registeredUsername: username } });
        } catch (error) {
            toast("error", errorMessage(error, t("auth.requestFailed")));
        } finally {
            setSubmitting(false);
        }
    };

    const handle2fa = async (values: TwoFactorValues) => {
        setSubmitting(true);
        try {
            await complete2fa(flowToken, values.code);
            setBooting(true);
            setBootPercent(8);
            setBootStatus(bootStatuses[0] || t("auth.bootPullConfig"));
            toast("success", t("auth.loginSuccess"));
            await runBootThenNavigate();
        } catch (error) {
            toast("error", errorMessage(error, t("auth.requestFailed")));
        } finally {
            setSubmitting(false);
        }
    };

    const handleSendCode = async () => {
        const email = readRegisterEmail(registerForm);
        if (!email) {
            registerForm.setFields([{ name: "email", errors: [t("auth.emailRequired")] }]);
            toast("error", t("auth.emailRequired"));
            setSendHint(t("auth.emailRequired"));
            return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            registerForm.setFields([{ name: "email", errors: [t("auth.emailInvalid")] }]);
            toast("error", t("auth.emailInvalid"));
            setSendHint(t("auth.emailInvalid"));
            return;
        }
        setSendingCode(true);
        setSendHint(t("auth.sendingCode"));
        try {
            await sendEmailVerification(email);
            setCountdown(60);
            toast("success", t("auth.codeSent"));
            setSendHint(t("auth.codeSent"));
        } catch (error) {
            const text = errorMessage(error, t("auth.requestFailed"));
            toast("error", text);
            setSendHint(text);
        } finally {
            setSendingCode(false);
        }
    };

    const openReset = () => {
        setNewPassword("");
        setResetStep(1);
        const username = fieldText(loginForm.getFieldValue("username"));
        if (username.includes("@")) resetForm.setFieldsValue({ email: username, token: "" });
        else resetForm.setFieldsValue({ token: "" });
        setResetOpen(true);
    };

    const handleSendReset = async () => {
        try {
            const values = await resetForm.validateFields(["email"]);
            const email = fieldText(values.email);
            setResetSending(true);
            await sendPasswordResetEmail(email);
            toast("success", t("auth.resetEmailSent"));
            setResetStep(2);
        } catch (error) {
            if ((error as { errorFields?: unknown })?.errorFields) return;
            toast("error", errorMessage(error, t("auth.requestFailed")));
        } finally {
            setResetSending(false);
        }
    };

    const handleConfirmReset = async () => {
        try {
            const values = await resetForm.validateFields(["email", "token"]);
            setResetConfirming(true);
            const password = await confirmPasswordReset(fieldText(values.email), fieldText(values.token));
            setNewPassword(password);
            setResetStep(3);
            toast("success", t("auth.resetSuccess"));
        } catch (error) {
            if ((error as { errorFields?: unknown })?.errorFields) return;
            toast("error", errorMessage(error, t("auth.requestFailed")));
        } finally {
            setResetConfirming(false);
        }
    };

    const copyNewPassword = async () => {
        if (!newPassword) return;
        try {
            await navigator.clipboard.writeText(newPassword);
            toast("success", t("auth.resetCopied"));
        } catch {
            toast("error", t("auth.requestFailed"));
        }
    };

    const useNewPasswordLogin = () => {
        const email = fieldText(resetForm.getFieldValue("email"));
        loginForm.setFieldsValue({
            ...(email ? { username: email } : {}),
            password: newPassword,
        });
        setResetOpen(false);
        setNewPassword("");
        setResetStep(1);
        if (location.pathname.includes("/user/reset")) {
            navigate("/login", { replace: true, state: { from } });
        }
    };

    const icon = (Icon: typeof User) => <Icon className="size-4 text-white/35" />;

    return (
        <ConfigProvider theme={loginTheme}>
            <App>
            <style>{`
              .boot-radar { width: 48px; height: 48px; position: relative; }
              .boot-radar-ring, .boot-radar-ring-inner, .boot-radar-sweep, .boot-radar-needle {
                position: absolute; inset: 6%; border-radius: 999px;
              }
              .boot-radar-ring { border: 1px solid color-mix(in srgb, ${BOOT_PRIMARY} 35%, transparent); }
              .boot-radar-ring-inner { inset: 18%; border: 1px solid color-mix(in srgb, ${BOOT_PRIMARY} 28%, transparent); }
              .boot-radar-sweep {
                background: conic-gradient(from 0deg, transparent 0%, transparent 62%, ${BOOT_PRIMARY} 92%, transparent 100%);
                animation: boot-spin 2s linear infinite; opacity: 0.9;
              }
              .boot-radar-needle { animation: boot-spin 2s linear infinite; }
              .boot-radar-needle::before {
                content: ""; position: absolute; left: 50%; top: 0; width: 1px; height: 50%;
                background: color-mix(in srgb, ${BOOT_PRIMARY} 80%, white); transform: translateX(-50%);
              }
              .boot-radar-dot {
                position: absolute; left: 50%; top: 50%; width: 8px; height: 8px; margin: -4px 0 0 -4px;
                border-radius: 999px; background: ${BOOT_PRIMARY};
                animation: boot-pulse 2.8s ease-in-out infinite;
              }
              @keyframes boot-spin { to { transform: rotate(360deg); } }
              @keyframes boot-pulse {
                0%, 100% { transform: scale(0.82); opacity: 0.45; }
                50% { transform: scale(1); opacity: 1; }
              }
              @media (prefers-reduced-motion: reduce) {
                .boot-radar-sweep, .boot-radar-needle, .boot-radar-dot { animation: none !important; }
              }
            `}</style>
            <div className="relative min-h-dvh overflow-hidden bg-[#070708] text-white">
                <div className="absolute inset-0 lg:right-[min(42rem,44%)]">
                    <video className="absolute inset-0 size-full object-cover" src={publicAsset("login-bg.mp4")} poster={publicAsset("login-bg-poster.jpg")} muted autoPlay loop playsInline />
                    <div className="absolute inset-0 bg-gradient-to-t from-black via-black/35 to-black/10" />
                    <div className="absolute inset-y-0 right-0 hidden w-1/3 bg-gradient-to-r from-transparent to-black lg:block" />
                    <div className="relative flex h-full min-h-dvh flex-col justify-between px-8 py-8 sm:px-12 lg:px-16 lg:py-12">
                        <div className="flex items-center gap-3 text-sm font-medium tracking-wide">
                            <span className="size-6 bg-white" style={{ mask: `url(${publicAsset("logo.svg")}) center / contain no-repeat`, WebkitMask: `url(${publicAsset("logo.svg")}) center / contain no-repeat` }} />
                            {t("meta.title")}
                        </div>
                        <div className="max-w-xl pb-8 lg:pb-4">
                            <div className="mb-4 text-[11px] font-medium tracking-[0.42em] text-white/55">{t("auth.brandMark")}</div>
                            <h1 className="text-4xl font-semibold leading-[1.15] tracking-tight sm:text-5xl lg:text-[3.5rem]">
                                {t("auth.sloganLine1")}
                                <br />
                                {t("auth.sloganLine2")}
                            </h1>
                        </div>
                    </div>
                </div>

                <div className="relative z-10 flex min-h-dvh items-center justify-center px-4 py-10 lg:ml-auto lg:w-[min(42rem,44%)] lg:bg-[#09090b] lg:px-10">
                    <button type="button" className="absolute right-4 top-4 z-20 inline-flex size-8 items-center justify-center rounded-full text-[11px] font-semibold text-white/70 transition hover:bg-white/10 hover:text-white" onClick={() => void changeAppLocale(nextLocale)} aria-label={languageLabel}>
                        {locale === "zh-CN" ? "中" : "EN"}
                    </button>
                    <div className="w-full max-w-[420px] rounded-2xl border border-white/10 bg-white/[0.03] px-6 py-8 shadow-[0_24px_80px_rgba(0,0,0,0.35)] sm:px-8">
                        {booting ? (
                            <div className="py-2 text-center" role="status" aria-busy="true" aria-live="polite">
                                <p className="text-[11px] font-medium tracking-[0.28em] text-white/40">{t("auth.loginEyebrow")}</p>
                                <h2 className="mt-2 text-2xl font-semibold tracking-tight">{t("auth.bootTitle")}</h2>
                                <div className="mt-8 rounded-2xl px-5 py-8" style={{ background: "color-mix(in srgb, #2F6BFF 14%, #0b1224)" }}>
                                    <RadarSpinner />
                                    <h3 className="text-base font-semibold" style={{ color: BOOT_PRIMARY }}>{t("auth.bootTitle")}</h3>
                                    <p className="mt-2 text-sm text-white/55">{bootStatus}</p>
                                    <div className="mt-5 h-2.5 overflow-hidden rounded-full bg-white/10">
                                        <i className="block h-full rounded-full transition-all duration-300" style={{ width: `${bootPercent}%`, background: BOOT_PRIMARY }} />
                                    </div>
                                    <div className="mt-3 flex justify-between text-xs text-white/50">
                                        <span>{bootStatus}</span>
                                        <span className="tabular-nums font-medium text-white/70">{bootPercent}%</span>
                                    </div>
                                </div>
                            </div>
                        ) : flowToken ? (
                            <>
                                <p className="text-[11px] font-medium tracking-[0.28em] text-white/40">{t("auth.twoFactorEyebrow")}</p>
                                <h2 className="mt-2 text-2xl font-semibold tracking-tight">{t("auth.twoFactorTitle")}</h2>
                                <p className="mt-2 text-sm leading-6 text-white/45">{t("auth.twoFactorDescription")}</p>
                                <Form form={twoFactorForm} layout="vertical" requiredMark={false} className="mt-8" onFinish={(values) => void handle2fa(values)}>
                                    <Form.Item name="code" className={fieldClass} rules={[{ required: true, message: t("auth.codeRequired") }, { pattern: /^\d{6}$/, message: t("auth.codeRequired") }]}>
                                        <Input size="large" className={inputClass} maxLength={6} inputMode="numeric" autoComplete="one-time-code" prefix={icon(Shield)} placeholder={t("auth.verificationCodePlaceholder")} />
                                    </Form.Item>
                                    <Button type="primary" htmlType="submit" size="large" block loading={submitting || booting} className="mt-2 h-11 font-medium">
                                        {t("auth.twoFactorAction")}
                                    </Button>
                                    <button type="button" className="mt-4 w-full text-center text-sm text-white/45 transition hover:text-white" onClick={() => setFlowToken("")}>
                                        {t("auth.backToLogin")}
                                    </button>
                                </Form>
                            </>
                        ) : (
                            <>
                                <p className="text-[11px] font-medium tracking-[0.28em] text-white/40">{t(mode === "register" ? "auth.registerEyebrow" : "auth.loginEyebrow")}</p>
                                <h2 className="mt-2 text-2xl font-semibold tracking-tight">{t(mode === "register" ? "auth.registerTitle" : "auth.loginTitle")}</h2>
                                <p className="mt-2 text-sm leading-6 text-white/45">{t(mode === "register" ? "auth.registerDescription" : "auth.loginDescription")}</p>
                                <div className="mt-8 grid grid-cols-2 text-sm">
                                    <Link to="/login" state={{ from }} className={`flex h-10 items-center justify-center border-b transition ${mode === "login" ? "border-white text-white" : "border-white/10 text-white/40 hover:text-white/70"}`}>
                                        {t("auth.tabLogin")}
                                    </Link>
                                    <Link to="/register" state={{ from }} className={`flex h-10 items-center justify-center border-b transition ${mode === "register" ? "border-white text-white" : "border-white/10 text-white/40 hover:text-white/70"}`}>
                                        {t("auth.tabRegister")}
                                    </Link>
                                </div>

                                {mode === "login" ? (
                                    <Form form={loginForm} layout="vertical" requiredMark={false} className="mt-8" onFinish={(values) => void handleLogin(values)}>
                                        <Form.Item name="username" label={t("auth.username")} className={fieldClass} rules={[{ required: true, message: t("auth.usernameRequired") }]}>
                                            <Input size="large" className={inputClass} autoComplete="username" prefix={icon(User)} placeholder={t("auth.usernamePlaceholder")} disabled={booting} />
                                        </Form.Item>
                                        <Form.Item name="password" label={t("auth.password")} className="mb-2" rules={[{ required: true, message: t("auth.passwordRequired") }]}>
                                            <Input.Password
                                                size="large"
                                                className={`${inputClass} [&_.ant-input-password-icon]:text-white/70`}
                                                autoComplete="current-password"
                                                prefix={icon(Lock)}
                                                placeholder={t("auth.passwordPlaceholder")}
                                                visibilityToggle
                                                iconRender={(visible) => (visible ? icon(EyeOff) : icon(Eye))}
                                                disabled={booting}
                                            />
                                        </Form.Item>
                                        <div className="mb-4 flex justify-end">
                                            <button type="button" className="text-xs text-white/45 transition hover:text-white" onClick={openReset} disabled={booting}>
                                                {t("auth.forgotPassword")}
                                            </button>
                                        </div>
                                        <Button type="primary" htmlType="submit" size="large" block loading={submitting || booting} className="mt-2 h-11 font-medium">
                                            {t("auth.loginAction")}
                                        </Button>
                                    </Form>
                                ) : (
                                    <Form form={registerForm} layout="vertical" requiredMark={false} className="mt-8" onFinish={(values) => void handleRegister(values)}>
                                        <Form.Item name="username" label={t("auth.registerUsername")} className={fieldClass} rules={[{ required: true, message: t("auth.registerUsernameRequired") }, { max: 20, message: t("auth.usernameLength") }]}>
                                            <Input size="large" className={inputClass} maxLength={20} autoComplete="username" prefix={icon(User)} placeholder={t("auth.registerUsernamePlaceholder")} />
                                        </Form.Item>
                                        <Form.Item name="email" label={t("auth.email")} className={fieldClass} rules={[{ required: true, message: t("auth.emailRequired") }, { type: "email", message: t("auth.emailInvalid") }]}>
                                            <Input size="large" className={inputClass} autoComplete="email" prefix={icon(Mail)} placeholder={t("auth.emailPlaceholder")} />
                                        </Form.Item>
                                        <Form.Item label={t("auth.verificationCode")} className={fieldClass}>
                                            <div className="flex gap-2">
                                                <Form.Item name="verification_code" noStyle rules={[{ required: true, message: t("auth.codeRequired") }, { pattern: /^\d{6}$/, message: t("auth.codeRequired") }]}>
                                                    <Input size="large" className={inputClass} maxLength={6} inputMode="numeric" prefix={icon(Shield)} placeholder={t("auth.verificationCodePlaceholder")} />
                                                </Form.Item>
                                                <Button htmlType="button" size="large" className="h-11 shrink-0 px-3" loading={sendingCode} disabled={countdown > 0} onClick={() => void handleSendCode()}>
                                                    {countdown > 0 ? t("auth.resendAfter", { seconds: countdown }) : t("auth.sendCode")}
                                                </Button>
                                            </div>
                                            {sendHint ? <p className="mt-2 mb-0 text-xs text-white/55">{sendHint}</p> : null}
                                        </Form.Item>
                                        <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
                                            <Form.Item name="password" label={t("auth.password")} className={fieldClass} rules={[{ required: true, message: t("auth.passwordRequired") }, { min: 8, max: 20, message: t("auth.passwordLength") }]}>
                                                <Input.Password size="large" className={inputClass} autoComplete="new-password" placeholder={t("auth.passwordPlaceholder")} />
                                            </Form.Item>
                                            <Form.Item
                                                name="confirmPassword"
                                                label={t("auth.confirmPassword")}
                                                className={fieldClass}
                                                dependencies={["password"]}
                                                rules={[
                                                    { required: true, message: t("auth.confirmPasswordRequired") },
                                                    ({ getFieldValue }) => ({
                                                        validator(_, value) {
                                                            if (!value || getFieldValue("password") === value) return Promise.resolve();
                                                            return Promise.reject(new Error(t("auth.passwordMismatch")));
                                                        },
                                                    }),
                                                ]}
                                            >
                                                <Input.Password size="large" className={inputClass} autoComplete="new-password" placeholder={t("auth.confirmPasswordPlaceholder")} />
                                            </Form.Item>
                                        </div>
                                        {SHOW_INVITE_CODE ? (
                                            <Form.Item name="aff_code" label={t("auth.inviteCode")} className={fieldClass}>
                                                <Input size="large" className={inputClass} placeholder={t("auth.invitePlaceholder")} />
                                            </Form.Item>
                                        ) : null}
                                        <Button type="primary" htmlType="submit" size="large" block loading={submitting} className="mt-1 h-11 font-medium">
                                            {t("auth.registerAction")}
                                        </Button>
                                    </Form>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </div>

            <Modal
                open={resetOpen}
                title={t("auth.resetTitle")}
                onCancel={() => {
                    if (resetConfirming || resetSending) return;
                    setResetOpen(false);
                    if (location.pathname.includes("/user/reset")) navigate("/login", { replace: true, state: { from } });
                }}
                footer={null}
                destroyOnHidden
            >
                <p className="mb-4 text-sm text-white/55">{t("auth.resetDescription")}</p>
                <div className="mb-4 flex gap-2 text-xs">
                    <span className={`rounded-full px-2 py-1 ${resetStep === 1 ? "bg-white/15 text-white" : "bg-white/5 text-white/45"}`}>{t("auth.resetStep1")}</span>
                    <span className={`rounded-full px-2 py-1 ${resetStep >= 2 ? "bg-white/15 text-white" : "bg-white/5 text-white/45"}`}>{t("auth.resetStep2")}</span>
                </div>
                <Form form={resetForm} layout="vertical" requiredMark={false}>
                    <Form.Item name="email" label={t("auth.email")} rules={[{ required: true, message: t("auth.emailRequired") }, { type: "email", message: t("auth.emailInvalid") }]}>
                        <Input size="large" className={inputClass} autoComplete="email" prefix={icon(Mail)} placeholder={t("auth.emailPlaceholder")} disabled={resetStep === 3} />
                    </Form.Item>
                    {resetStep >= 2 && resetStep < 3 ? (
                        <Form.Item name="token" label={t("auth.resetToken")} rules={[{ required: true, message: t("auth.resetTokenRequired") }]}>
                            <Input size="large" className={inputClass} placeholder={t("auth.resetTokenPlaceholder")} />
                        </Form.Item>
                    ) : null}
                    {resetStep === 3 ? (
                        <div className="mb-4 rounded-xl border border-white/10 bg-white/[0.04] p-4">
                            <div className="text-xs text-white/45">{t("auth.resetNewPassword")}</div>
                            <div className="mt-2 font-mono text-lg tracking-[0.2em] text-white">{newPassword}</div>
                            <div className="mt-3 flex flex-wrap gap-2">
                                <Button onClick={() => void copyNewPassword()}>{t("auth.resetCopyPassword")}</Button>
                                <Button type="primary" onClick={useNewPasswordLogin}>{t("auth.resetUseNewPassword")}</Button>
                            </div>
                        </div>
                    ) : null}
                    {resetStep === 1 ? (
                        <Button type="primary" block size="large" className="h-11" loading={resetSending} onClick={() => void handleSendReset()}>
                            {t("auth.resetSendEmail")}
                        </Button>
                    ) : null}
                    {resetStep === 2 ? (
                        <div className="flex gap-2">
                            <Button className="h-11" onClick={() => setResetStep(1)}>{t("auth.resetBack")}</Button>
                            <Button type="primary" block size="large" className="h-11" loading={resetConfirming} onClick={() => void handleConfirmReset()}>
                                {t("auth.resetConfirm")}
                            </Button>
                        </div>
                    ) : null}
                </Form>
            </Modal>
            </App>
        </ConfigProvider>
    );
}
