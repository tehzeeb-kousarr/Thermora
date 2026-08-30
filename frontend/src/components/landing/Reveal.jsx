import React from 'react';
import { motion } from 'motion/react';

/**
 * Wraps children in a fade + slide-up entrance animation that triggers
 * once, the moment the element scrolls into view. Used throughout the
 * landing page so sections feel alive without being distracting.
 *
 * Usage: <Reveal delay={0.1}><YourSection /></Reveal>
 */
export const Reveal = ({
  children,
  delay = 0,
  y = 24,
  duration = 0.6,
  className = '',
  as = 'div',
}) => {
  const MotionTag = motion[as] || motion.div;
  return (
    <MotionTag
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </MotionTag>
  );
};

/**
 * Staggers the entrance of its direct motion children. Wrap a grid of
 * cards in this, then use <RevealItem> (or motion elements) inside.
 */
export const RevealGroup = ({ children, className = '', stagger = 0.08 }) => (
  <motion.div
    className={className}
    initial="hidden"
    whileInView="show"
    viewport={{ once: true, margin: '-80px' }}
    variants={{
      hidden: {},
      show: { transition: { staggerChildren: stagger } },
    }}
  >
    {children}
  </motion.div>
);

export const RevealItem = ({ children, className = '', y = 20 }) => (
  <motion.div
    className={className}
    variants={{
      hidden: { opacity: 0, y },
      show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] } },
    }}
  >
    {children}
  </motion.div>
);
