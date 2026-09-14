'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Catches render/lifecycle errors in its subtree and shows a retry UI
 * instead of taking down the whole dashboard — each major panel is wrapped
 * in its own instance so one broken widget (e.g. a malformed API response)
 * doesn't blank the entire page.
 */
export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an unhandled error:', error, errorInfo);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="bg-[#0D1117] border border-red-500/40 rounded-xl p-6 text-center my-2 shadow-lg backdrop-blur-md">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-500/10 border border-red-500/30 text-red-400 mb-3">
            <svg
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <h3 className="text-base font-semibold text-slate-100 uppercase tracking-wider font-mono">
            {this.props.fallbackTitle || 'Component Visualizer Offline'}
          </h3>
          <p className="text-xs text-slate-400 font-mono mt-2 max-w-md mx-auto line-clamp-2">
            {this.state.error?.message || 'An unexpected rendering exception was caught.'}
          </p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <button
              onClick={this.handleRetry}
              className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wider bg-red-600/80 hover:bg-red-600 text-white rounded-md transition-colors"
            >
              Retry Component
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wider bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-md border border-slate-700 transition-colors"
            >
              Reset Telemetry
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
