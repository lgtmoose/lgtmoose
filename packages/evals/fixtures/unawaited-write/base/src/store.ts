export interface NotificationSettings {
  email: boolean;
  push: boolean;
}

export interface SettingsStore {
  /** Rejects when the write fails, e.g. the database is unreachable. */
  save(userId: string, settings: NotificationSettings): Promise<void>;
  load(userId: string): Promise<NotificationSettings | undefined>;
}
