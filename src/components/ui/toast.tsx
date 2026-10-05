'use client';

import { createContext, useContext, useState } from 'react';

type ToastType = 'default' | 'destructive' | 'success';

interface Toast {
  id: string;
  title?: string;
  description: string;
  variant?: ToastType;
  duration?: number;
}

interface ToastContextType {
  toasts: Toast[];
  toast: (props: Omit<Toast, 'id'>) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = ({ title, description, variant = 'default', duration = 5000 }: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).substring(2, 9);
    const newToast = { id, title, description, variant, duration };
    
    setToasts((prev) => [...prev, newToast]);
    
    if (duration > 0) {
      setTimeout(() => {
        dismiss(id);
      }, duration);
    }
    
    return id;
  };

  const dismiss = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <ToastContext.Provider value={{ toasts, toast, dismiss }}>
      {children}
      
      <div className="fixed bottom-4 left-1/2 transform -translate-x-1/2 z-50 flex flex-col gap-2 max-w-md">
        {toasts.map((t) => (
          <div 
            key={t.id} 
            className={`p-4 rounded-md shadow-lg animate-in fade-in slide-in-from-right-5 ${
              t.variant === 'destructive' 
                ? 'bg-red-500 text-white' 
                : t.variant === 'success'
                ? 'bg-green-500 text-white'
                : 'bg-white dark:bg-gray-800 text-black dark:text-white'
            }`}
          >
            {t.title && (
              <div className="font-medium">{t.title}</div>
            )}
            <div className={t.title ? "text-sm opacity-90" : ""}>{t.description}</div>
            <button 
              className="absolute top-1 right-1 text-xs opacity-70 hover:opacity-100"
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => {
  const context = useContext(ToastContext);
  
  if (context === undefined) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  
  return context;
};
