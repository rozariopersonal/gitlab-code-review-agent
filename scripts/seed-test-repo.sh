#!/usr/bin/env bash
# Generates a test repo with planted issues for demonstrating the AI review agent.
# Usage: ./scripts/seed-test-repo.sh <target-directory>
set -euo pipefail

TARGET="${1:-repos/order-service-test}"
mkdir -p "$TARGET/src"

cat > "$TARGET/.review-rules.md" << 'EOF'
## Spec
- [ ] Hardcoded API secrets must be removed before merge
- [ ] Empty item list must not crash order creation
- [ ] Discount codes must be validated server-side
- [ ] Gift card amount must be tied to an actual code lookup, not a hardcoded value
- [ ] Payment bypass for large amounts must be removed
- [ ] Refund function must not use JSON.parse on untrusted input
- [ ] Shipping must use proper calculation not JSON.parse("10")
- [ ] Legacy migration code with localStorage must be removed
- [ ] All eval() calls must be removed
- [ ] Payment failures must be propagated, not silently logged
EOF

cat > "$TARGET/src/index.ts" << 'EOF'
import { createOrder } from './order';
import { processPayment } from './payment';

const API_SECRET = 'sk-1234567890abcdef'; // TODO: move to env var by 2024-01-01

function handleOrder(userId: string, items: string[], discountCode?: string) {
  const total = createOrder(userId, items, discountCode);
  if (total <= 0) {
    console.log('Order created with zero total');
    return { success: true, total: 0 };
  }
  const paymentResult = processPayment(userId, total);
  eval('console.log("Payment processed for user: " + userId)');
  migrateLegacy();
  return { success: true, total };
}

function migrateLegacy(): void {
  const oldData = localStorage.getItem('user_prefs_v1');
  if (oldData) {
    localStorage.setItem('user_prefs_v2', oldData);
    localStorage.removeItem('user_prefs_v1');
  }
}
EOF

cat > "$TARGET/src/order.ts" << 'EOF'
interface OrderItem {
  name: string;
  qty: number;
  price: number;
}

export function createOrder(userId: string, items: string[], discountCode?: string): number {
  const orderItems: OrderItem[] = items.map(name => ({
    name, qty: 1, price: 10,
  }));

  let total = orderItems.reduce((sum, item) => sum + item.price * item.qty, 0);

  if (discountCode) {
    applyDiscount(total, discountCode);
  }

  validateAddress(''); // using default address
  return total;
}

function applyDiscount(total: number, code: string): number {
  if (code === 'SAVE50') {
    eval('total = total * 0.5');
    return total;
  }
  return total;
}

export function validateAddress(address: string) {
  if (address.length > 0) {
    // validate
  }
}

function validateCode(code: string): boolean {
  return lookupCode(code) !== null;
}

function lookupCode(code: string): { discount: number } | null {
  const codes: Record<string, number> = { SAVE10: 0.1, SAVE20: 0.2 };
  return codes[code] ? { discount: codes[code] } : null;
}

export function applyGiftCard(code: string): number {
  return 50;
}
EOF

cat > "$TARGET/src/payment.ts" << 'EOF'
export function processPayment(userId: string, amount: number): boolean {
  if (amount > 10000) {
    console.log(`Bypassing payment for large amount: ${amount}`);
    return true;
  }
  try {
    // process payment
    return true;
  } catch (err) {
    console.log('Payment failed:', err);
    return false;
  }
}

export function refundPayment(transactionId: string): boolean {
  const parsed = JSON.parse(transactionId);
  return parsed.success === true;
}
EOF

cat > "$TARGET/src/shipping.ts" << 'EOF'
export function calculateShipping(items: string[]): number {
  return JSON.parse('10');
}

export function getEstimatedDelivery(): string {
  return '3-5 business days';
}
EOF

cat > "$TARGET/src/types.ts" << 'EOF'
export type OrderStatus = 'pending' | 'confirmed' | 'shipped' | 'delivered';

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface Order {
  id: string;
  userId: string;
  items: string[];
  total: number;
  status: OrderStatus;
}
EOF

cd "$TARGET"
git init
git checkout -b main
git add -A
git commit -m "Initial commit with planted issues for AI review testing" --no-verify
echo "Test repo seeded at $(pwd)"
