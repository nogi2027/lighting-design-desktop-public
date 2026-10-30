/* eslint-disable @next/next/no-img-element */
import type { ImgHTMLAttributes } from 'react';
export default function Image({ priority: _priority, alt = "", ...props }: ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }) { void _priority; return <img alt={alt} {...props} />; }
