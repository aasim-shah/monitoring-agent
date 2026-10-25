'use client';
import { useState, type ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogClose,
} from '@/components/ui/dialog';
export function PageDialog({
  label,
  title,
  description,
  children,
}: {
  label: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus size={16} />
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <div className="portal-dialog-heading">
          <div>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </div>
          <DialogClose asChild>
            <button type="button" className="portal-dialog-close" aria-label="Close dialog">
              <X size={18} />
            </button>
          </DialogClose>
        </div>
        {children}
      </DialogContent>
    </Dialog>
  );
}
