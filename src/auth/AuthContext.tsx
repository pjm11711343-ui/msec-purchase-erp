import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, C, db, loginToEmail, vendorEmail } from '../lib/firebase';
import type { ErpUser, Role, VendorAccount } from '../types';

interface AuthState {
  fbUser: User | null;
  profile: ErpUser | null;
  vendor: VendorAccount | null; // 업체 포털 계정
  loading: boolean;
  login: (idOrEmail: string, password: string) => Promise<void>;
  vendorLogin: (code: string, accessCode: string) => Promise<void>;
  logout: () => Promise<void>;
  /** 전체 현장 권한이면 null, 아니면 담당 현장 id 목록 */
  siteIds: string[] | null;
  can: (...roles: Role[]) => boolean;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [fbUser, setFbUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<ErpUser | null>(null);
  const [vendor, setVendor] = useState<VendorAccount | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let unsubs: (() => void)[] = [];
    const stop = () => {
      unsubs.forEach((u) => u());
      unsubs = [];
    };
    const unsub = onAuthStateChanged(auth, (u) => {
      setFbUser(u);
      stop();
      if (!u) {
        setProfile(null);
        setVendor(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      // 사내 사용자 문서와 업체 계정 문서 중 있는 쪽을 쓴다
      let pending = 2;
      const done = () => {
        pending -= 1;
        if (pending <= 0) setLoading(false);
      };
      unsubs.push(
        onSnapshot(
          doc(db, C.users, u.uid),
          (d) => {
            setProfile(d.exists() ? { ...(d.data() as Omit<ErpUser, 'id'>), id: d.id } : null);
            done();
          },
          () => {
            setProfile(null);
            done();
          },
        ),
        onSnapshot(
          doc(db, C.vendorAccounts, u.uid),
          (d) => {
            setVendor(d.exists() ? { ...(d.data() as Omit<VendorAccount, 'id'>), id: d.id } : null);
            done();
          },
          () => {
            setVendor(null);
            done();
          },
        ),
      );
    });
    return () => {
      unsub();
      stop();
    };
  }, []);

  const value: AuthState = {
    fbUser,
    profile,
    vendor,
    loading,
    login: async (idOrEmail, password) => {
      await signInWithEmailAndPassword(auth, loginToEmail(idOrEmail), password);
    },
    vendorLogin: async (code, accessCode) => {
      await signInWithEmailAndPassword(auth, vendorEmail(code), accessCode);
    },
    logout: () => signOut(auth),
    siteIds: profile && (profile.role === 'admin' || profile.role === 'material') ? null : (profile?.siteIds ?? []),
    can: (...roles) => Boolean(profile && profile.active && roles.includes(profile.role)),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider 밖에서 useAuth를 썼습니다.');
  return v;
}
