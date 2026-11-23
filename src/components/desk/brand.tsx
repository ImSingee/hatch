import { Text } from '@mantine/core';
import classes from './brand.module.css';

type BrandProps = {
  size?: 'xs' | 'sm' | 'md' | 'lg';
  withWordmark?: boolean;
};

const MARK_SIZE = { xs: 20, sm: 28, md: 32, lg: 44 } as const;
const WORD_SIZE = { xs: 14, sm: 18, md: 18, lg: 24 } as const;
const BRAND_ICON_SRC = '/logo192.png?v=20260828';

export function Brand({ size = 'md', withWordmark = true }: BrandProps) {
  return (
    <div className={classes.root} data-size={size}>
      <div
        className={classes.mark}
        style={{ width: MARK_SIZE[size], height: MARK_SIZE[size] }}
      >
        <img
          className={classes.image}
          src={BRAND_ICON_SRC}
          alt=""
          draggable={false}
        />
      </div>
      {withWordmark ? (
        <Text component="span" className={classes.word} fz={WORD_SIZE[size]}>
          Hatch
        </Text>
      ) : null}
    </div>
  );
}
