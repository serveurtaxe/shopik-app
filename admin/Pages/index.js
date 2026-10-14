import Permissions from 'Pages/Permissions'
import Dashboard from 'Pages/Dashboard'
import { useUser } from 'features/User'
import Settings from 'Pages/Settings'
import Products from 'Pages/Products'
import Admins from 'Pages/Admins'
import Stores from 'Pages/Stores'
import Domains from 'Pages/Domains'
import Orders from 'Pages/Orders'
import Order from 'Pages/Orders/Order'
import Users from 'Pages/Users'
import User from 'Pages/Users/User'
import Logs from 'Pages/Logs'
import Sales from 'Pages/Sales'
import Coupons from 'Pages/Coupons'
import DisplayBlocks from 'Pages/DisplayBlocks'
import ComaxProducts from 'Pages/ComaxProducts'
import SupplyAreas from 'Pages/SupplyAreas'
import ComaxSales from 'Pages/ComaxSales'
import Windows from 'Pages/Windows'
import Ops from 'Pages/Ops'
import OpsOrder from 'Pages/Ops/OpsOrder'
import ApiKeys from 'Pages/ApiKeys'
import DevTools from 'Pages/DevTools'

const pages = [
    { key: 'dashboard', name: 'Dashboard', path: '/', section: 'main', icon: 'desktop', component: Dashboard,/*  permission: 'dashboard:read' */ },

    { key: 'products', name: 'Products', path: '/products', section: 'content', icon: 'products', component: Products, permission: 'product:read' },
    { key: 'users', name: 'users', path: '/users', section: 'content', icon: 'users', component: Users, permission: 'user:read' },
    { key: 'user', name: ' ', path: '/users/:userId', section: 'content', icon: 'users', component: User, permission: 'user:read', notInMenu: true },
    { key: 'orders', name: 'orders', path: '/orders', section: 'content', icon: 'orders', component: Orders, permission: 'order:read' },
    { key: 'order', name: ' ', path: '/orders/:orderId', section: 'content', icon: 'orders', component: Order, permission: 'order:read', notInMenu: true },
    { key: 'sales', name: 'Sales', path: '/sales', section: 'content', icon: 'sale', component: Sales, permission: 'sale:read' },
    { key: 'coupons', name: 'Coupons', path: '/coupons', section: 'content', icon: 'coupon', component: Coupons, permission: 'coupon:read' },
    { key: 'display-blocks', name: 'display_blocks', path: '/display-blocks', section: 'content', icon: 'blocks', component: DisplayBlocks, permission: 'display_block:read' },

    { key: 'admins', name: 'Admins', path: '/admins', section: 'management', icon: 'persons', component: Admins, permission: 'admin:read' },
    { key: 'domains', name: 'Domains', path: '/domains', section: 'management', icon: 'domains', component: Domains, permission: 'domain:read' },
    { key: 'stores', name: 'Stores', path: '/stores', section: 'management', icon: 'stores', component: Stores, permission: 'store:read' },
    { key: 'supply-areas', name: 'Supply Areas', path: '/supply-areas', section: 'management', icon: 'map', component: SupplyAreas, permission: 'supply_area:read' },
    { key: 'windows', name: 'Windows', path: '/windows', section: 'management', icon: 'calendar', component: Windows, permission: 'order_window_template:read' },

    { key: 'ops', name: 'ops-page', path: '/ops', section: 'operations', icon: 'orders', component: Ops, permission: ['order:read', 'order:pick', 'order:ship'] },
    { key: 'ops-order', name: ' ', path: '/ops-order/:orderId', section: 'operations', icon: 'orders', component: OpsOrder, permission: ['order:read', 'order:pick', 'order:ship'], notInMenu: true },

    { key: 'comax-products', name: 'Comax Products', path: '/comax-products', section: 'comax', icon: 'products', component: ComaxProducts, permission: 'comax_product:read' },
    { key: 'comax-sales', name: 'Comax Sales', path: '/comax-sales', section: 'comax', icon: 'sale', component: ComaxSales, permission: 'comax_sale:read' },

    { key: 'logs', name: 'Logs', path: '/logs', section: 'system', icon: 'log', component: Logs, permission: 'log:read' },
    { key: 'permissions', name: 'permissions', path: '/permissions', section: 'system', icon: 'key', component: Permissions, permission: 'role:create' },
    { key: 'api-keys', name: 'API Keys', path: '/api-keys', section: 'system', icon: 'key', component: ApiKeys, permission: 'api_key:read' },
    { key: 'settings', name: 'Settings', path: '/settings', section: 'system', icon: 'settings', component: Settings, permission: 'setting:read' },
    { key: 'dev-tools', name: 'Dev Tools', path: '/dev-tools', section: 'system', icon: 'log', component: DevTools, permission: 'admin:super' },
]

export default function usePages() {
    const { isSuperAdmin, role } = useUser()

    if (isSuperAdmin)
        return pages

    return pages.filter(p => {
        if (!p.permission) return true
        if (Array.isArray(p.permission)) return p.permission.some(perm => role.permissions.includes(perm))
        return role.permissions.includes(p.permission)
    })
} 