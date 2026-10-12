export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  imageUrl: string | null;
}

export interface CartLine {
  product: Product;
  quantity: number;
}

export interface OrderResponse {
  id: string;
  status: string;
  total: number;
  currency: string;
}

export interface Profile {
  email: string;
  displayName: string | null;
  accountType: 'guest' | 'customer';
}

export interface OrderHistory {
  id: string;
  status: string;
  total: number;
  currency: string;
  createdAt: string;
  items: OrderHistoryItem[];
}

export interface OrderHistoryItem {
  productName: string;
  quantity: number;
  unitPrice: number;
}

export interface WaitingRoomTicket {
  ticketId: string;
  state: 'queued' | 'admitted' | 'expired';
  position: number;
  retryAfterSeconds: number;
}
