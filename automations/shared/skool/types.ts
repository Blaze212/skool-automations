export interface SkoolMember {
  skoolId: string;
  name: string;
  joinDate: string;
  lastLoginDate: string;
  email: string;
  currentSituation: string;
  mainGoal: string;
}

export interface RawMemberData {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  metadata?: {
    bio?: string;
    lastOffline?: number;
    pictureBubble?: string;
  };
  createdAt?: string;
  member: {
    id?: string;
    createdAt: string;
    lastOffline: string;
    role?: string;
    approvedAt?: string;
    metadata?: {
      requestedAt?: number;
      survey?: string;
    };
  };
}
