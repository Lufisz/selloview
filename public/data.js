// Deliberately fictional fixtures. They never represent a connected store.
export const SAMPLE_DAYS = [
  { label: 'Thu', revenue: 32800, orders: 8 },
  { label: 'Fri', revenue: 46700, orders: 12 },
  { label: 'Sat', revenue: 38900, orders: 10 },
  { label: 'Sun', revenue: 61400, orders: 15 },
  { label: 'Mon', revenue: 42500, orders: 11 },
  { label: 'Tue', revenue: 53700, orders: 14 },
  { label: 'Wed', revenue: 48100, orders: 12 },
  { label: 'Thu', revenue: 44900, orders: 11 },
  { label: 'Fri', revenue: 58200, orders: 14 },
  { label: 'Sat', revenue: 42600, orders: 10 },
  { label: 'Sun', revenue: 73500, orders: 18 },
  { label: 'Mon', revenue: 51300, orders: 13 },
  { label: 'Tue', revenue: 66400, orders: 16 },
  { label: 'Wed', revenue: 78200, orders: 19 },
];

export const SAMPLE_ORDERS = [
  {
    id: '#1048',
    product: 'Linen everyday tote',
    amount: 4800,
    country: 'Netherlands',
    time: '14:42',
    status: 'Paid',
  },
  {
    id: '#1047',
    product: 'Ceramic pour-over set',
    amount: 8600,
    country: 'Germany',
    time: '14:18',
    status: 'Paid',
  },
  {
    id: '#1046',
    product: 'Studio notebook · Set of 3',
    amount: 3200,
    country: 'Sweden',
    time: '13:56',
    status: 'Fulfilled',
  },
  {
    id: '#1045',
    product: 'Linen everyday tote',
    amount: 4800,
    country: 'Lithuania',
    time: '13:31',
    status: 'Paid',
  },
  {
    id: '#1044',
    product: 'Oak desk tray',
    amount: 5600,
    country: 'Denmark',
    time: '12:47',
    status: 'Fulfilled',
  },
];

export const ATTENTION_ITEMS = [
  {
    id: 'fulfillment',
    type: 'Orders',
    title: '3 orders awaiting fulfillment',
    description: 'Over 24 hours',
    detail:
      'Sample orders #1032, #1036 and #1039 are awaiting fulfillment. In the connected product, this would open the matching orders in Shopify.',
    action: 'Review orders',
    tone: 'amber',
  },
  {
    id: 'stock',
    type: 'Inventory',
    title: 'Linen tote',
    description: '4 remaining · Low stock',
    detail:
      'Linen everyday tote / Natural: 4 available at the sample main location, below the threshold of 5. This prototype cannot update inventory or place an order.',
    action: 'View product',
    tone: 'neutral',
  },
];

export const DEFAULT_SETTINGS = {
  name: 'Sunday Supply',
  store: 'sunday-supply.myshopify.com',
  goal: 6000,
  showTraffic: true,
  showAttention: true,
  showOrders: true,
  theme: 'light',
  connection: 'sample',
};
