import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AuthProvider } from './auth';
import { LivePage } from './pages/LivePage';
import { LoginPage } from './pages/LoginPage';
import { HistoryPage } from './pages/HistoryPage';
import { ReplayPage } from './pages/ReplayPage';
import { KioskPage } from './pages/KioskPage';
import {
  AdminLayout,
  AircraftAdmin,
  AirfieldsAdmin,
  FlightsAdmin,
  MessagesAdmin,
  SettingsAdmin,
  StatusAdmin,
  UsersAdmin,
} from './pages/AdminPage';
import './styles.css';

const router = createBrowserRouter([
  { path: '/', element: <LivePage /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/history', element: <HistoryPage /> },
  { path: '/history/:flightId', element: <ReplayPage /> },
  { path: '/kiosk', element: <KioskPage /> },
  {
    path: '/admin',
    element: <AdminLayout />,
    children: [
      { index: true, element: <AircraftAdmin /> },
      { path: 'users', element: <UsersAdmin /> },
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
