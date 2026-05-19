import { google } from 'googleapis';

export const Scopes = {
  SHEETS: 'https://www.googleapis.com/auth/spreadsheets',
  DRIVE: 'https://www.googleapis.com/auth/drive',
} as const;

export function getGoogleAuth(serviceAccountKey: string, scopes: string[]) {
  const key = JSON.parse(serviceAccountKey) as object;
  return new google.auth.GoogleAuth({ credentials: key, scopes });
}
