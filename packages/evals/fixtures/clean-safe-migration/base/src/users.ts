export interface UserRow {
  id: string;
  email: string;
}

export function label(user: UserRow): string {
  return user.email;
}
