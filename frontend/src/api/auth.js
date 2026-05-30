import apiClient from './client.js';

/**
 * Refreshes the access token using the refresh token cookie.
 * Returns the updated access token payload.
 */
export async function refreshAccessToken() {
  const response = await apiClient.post('/api/auth/refresh');
  return response.data;
}

/**
 * Logs the user out on the server.
 */
export async function logout() {
  const response = await apiClient.post('/api/auth/logout');
  return response.data;
}

/**
 * Fetches the current authenticated user profile.
 */
export async function getProfile() {
  const response = await apiClient.get('/api/auth/profile');
  return response.data;
}
