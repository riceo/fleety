import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AuthProvider } from './auth';
import { LivePage } from './pages/LivePage';
import { LoginPage, SetPasswordPage } from './pages/LoginPage';
import { HistoryPage } from './pages/HistoryPage';
import { ReplayPage } from './pages/ReplayPage';
import { KioskPage } from './pages/KioskPage';
import { PlatformPage } from './pages/PlatformPage';
import { AccountPage } from './pages/AccountPage';
import {
  AdminLayout,
  AircraftAdmin,
  AirfieldsAdmin,
  FlightsAdmin,
  MembersAdmin,
  MessagesAdmin,
  SettingsAdmin,
  StatusAdmin,
} from './pages/AdminPage';
import './styles.css';

const router = createBrowserRouter([
  { path: '/', element: <LivePage /> },
  { path: '/ac/:reg', element: <LivePage /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/set-password', element: <SetPasswordPage /> },
  { path: '/history', element: <HistoryPage /> },
  { path: '/history/:flightId', element: <ReplayPage /> },
  { path: '/kiosk', element: <KioskPage /> },
  { path: '/platform', element: <PlatformPage /> },
  { path: '/account', element: <AccountPage /> },
  {
    path: '/admin',
    element: <AdminLayout />,
    children: [
      { index: true, element: <AircraftAdmin /> },
      { path: 'members', element: <MembersAdmin /> },
      { path: 'airfields', element: <AirfieldsAdmin /> },
      { path: 'messages', element: <MessagesAdmin /> },
      { path: 'flights', element: <FlightsAdmin /> },
      { path: 'settings', element: <SettingsAdmin /> },
      { path: 'status', element: <StatusAdmin /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </React.StrictMode>
);
