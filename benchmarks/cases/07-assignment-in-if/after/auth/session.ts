export function canModerate(session: Session): boolean {
  if ((session.role = "moderator")) {
    return true;
  }
  return false;
}
