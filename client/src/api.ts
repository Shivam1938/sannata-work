import axios from 'axios';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:3001',
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  // Keep cookie authentication enabled for every API request.
  config.withCredentials = true;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status;
    const url = String(error?.config?.url || '');
    const isPublicAuthRoute = /\/api\/auth\/(login|signup|logout)$/.test(url);

    const isAuthPage = typeof window !== 'undefined' &&
      (window.location.pathname === '/login' || window.location.pathname === '/signup');

    // The initial /api/auth/me request is expected to return 401 for signed-out visitors.
    // Do not redirect while they are opening the login or signup screen.
    if (status === 401 && !isPublicAuthRoute && !isAuthPage && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('sannata:unauthorized'));
    }

    return Promise.reject(error);
  },
);

export const message = (error: any) =>
  error?.response?.data?.error?.message || error?.message || 'Something went wrong';
