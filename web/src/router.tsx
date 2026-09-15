import { createBrowserRouter, createHashRouter, Outlet } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import { GuestOnly, RequireAuth } from "@/components/layout/require-auth";
import UserLayout from "@/layouts/user-layout";
import AssetsPage from "@/pages/assets";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import ConfigPage from "@/pages/config";
import HomePage from "@/pages/home";
import ImagePage from "@/pages/image";
import LoginPage from "@/pages/login";
import NotFound from "@/pages/not-found";
import PromptsPage from "@/pages/prompts";
import VideoPage from "@/pages/video";

const routes = [
    {
        element: (
            <GuestOnly>
                <Outlet />
            </GuestOnly>
        ),
        children: [
            { path: "/login", element: <LoginPage /> },
            { path: "/register", element: <LoginPage /> },
            { path: "/user/reset", element: <LoginPage /> },
        ],
    },
    {
        element: (
            <RequireAuth>
                <UserLayout>
                    <AnalyticsTracker />
                    <Outlet />
                </UserLayout>
            </RequireAuth>
        ),
        children: [
            { path: "/", element: <HomePage /> },
            { path: "/image", element: <ImagePage /> },
            { path: "/video", element: <VideoPage /> },
            { path: "/assets", element: <AssetsPage /> },
            { path: "/prompts", element: <PromptsPage /> },
            { path: "/canvas", element: <CanvasPage /> },
            { path: "/canvas/:id", element: <CanvasProjectPage /> },
            { path: "/config", element: <ConfigPage /> },
        ],
    },
    {
        path: "*",
        element: (
            <RequireAuth>
                <NotFound />
            </RequireAuth>
        ),
    },
];

export const router = import.meta.env.VITE_ROUTER_MODE === "hash" ? createHashRouter(routes) : createBrowserRouter(routes);
