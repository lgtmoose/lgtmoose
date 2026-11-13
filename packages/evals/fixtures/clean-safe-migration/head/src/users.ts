export interface UserRow {
  id: string;
  email: string;
  /** Null until the user sets one. */
  display_name: string | null;
}

/** What to show for a user: their display name, or their email when they haven't set one. */
export function label(user: UserRow): string {
  const name = user.display_name?.trim();
  return name ? name : user.email;
}
