'use client';

import React, { useState } from 'react';
import { LogIn, LogOut, User } from 'lucide-react';

interface GoogleUser {
  name: string;
  email: string;
  picture?: string;
}

/**
 * "Continue with Google" button and modal. Currently a mocked sign-in for
 * demo purposes — it doesn't call Google's real OAuth flow, just fabricates
 * a user object and POSTs it to the backend's `/api/auth/google` upsert
 * endpoint so the rest of the auth/settings plumbing has something to work
 * with. Wiring real NextAuth + Google OAuth would replace
 * `handleSimulateGoogleLogin`'s body with an actual `signIn('google')` call.
 */
export const GoogleAuthWidget: React.FC = () => {
  // Client state for Google Authentication
  const [currentUser, setCurrentUser] = useState<GoogleUser | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const handleSimulateGoogleLogin = async () => {
    // In production with NEXTAUTH_SECRET and GOOGLE_CLIENT_ID configured,
    // this initiates signIn('google'). For local demonstration and offline test:
    const mockGoogleUser: GoogleUser = {
      name: 'Onkar (F1 Fan)',
      email: 'onkar@f1app.dev',
      picture: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&auto=format&fit=crop',
    };

    setCurrentUser(mockGoogleUser);
    setIsOpen(false);

    // Sync with backend PostgreSQL
    try {
      await fetch('http://localhost:4000/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: mockGoogleUser.email,
          name: mockGoogleUser.name,
          image: mockGoogleUser.picture,
          googleId: 'google-sub-mock-12345',
        }),
      });
    } catch {
      // Backend handles in-memory fallback
    }
  };

  const handleLogout = () => {
    setCurrentUser(null);
  };

  if (currentUser) {
    return (
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 bg-slate-900 border border-slate-700/80 px-2.5 py-1 rounded-full">
          {currentUser.picture ? (
            <img
              src={currentUser.picture}
              alt={currentUser.name}
              className="w-6 h-6 rounded-full border border-amber-400"
            />
          ) : (
            <User className="w-4 h-4 text-slate-300" />
          )}
          <span className="text-xs font-mono text-slate-200 hidden sm:inline">
            {currentUser.name}
          </span>
        </div>
        <button
          onClick={handleLogout}
          title="Sign Out"
          className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded-lg transition-colors"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="flex items-center gap-2 px-3.5 py-1.5 bg-white hover:bg-slate-100 text-slate-900 font-semibold text-xs rounded-lg transition-all shadow-md active:scale-95"
      >
        {/* Official Google 'G' SVG Logo */}
        <svg className="w-4 h-4" viewBox="0 0 24 24">
          <path
            fill="#4285F4"
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
          />
          <path
            fill="#34A853"
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
          />
          <path
            fill="#FBBC05"
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
          />
          <path
            fill="#EA4335"
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
          />
        </svg>
        <span>Continue with Google</span>
      </button>

      {/* Google Sign-in Modal */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-[#121620] border border-slate-700 rounded-2xl max-w-sm w-full p-6 shadow-2xl relative text-center">
            <div className="w-12 h-12 rounded-full bg-white flex items-center justify-center mx-auto mb-4 shadow-lg">
              <svg className="w-6 h-6" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                />
              </svg>
            </div>

            <h3 className="text-base font-bold text-white mb-1">Continue with Google</h3>
            <p className="text-xs text-slate-400 mb-6">
              Sign in to save your favorite drivers, telemetry layouts, and race bookmarks.
            </p>

            <div className="space-y-3">
              <button
                onClick={handleSimulateGoogleLogin}
                className="w-full py-2.5 bg-white hover:bg-slate-100 text-slate-900 font-bold text-xs rounded-xl transition-all shadow-md flex items-center justify-center gap-2"
              >
                <LogIn className="w-4 h-4" /> Sign In with Google Account
              </button>

              <button
                onClick={() => setIsOpen(false)}
                className="w-full py-2 text-slate-400 hover:text-white text-xs font-mono"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default GoogleAuthWidget;
