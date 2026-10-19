/**
 * Generic CRUD type definitions for the Data Layer (DL).
 */

/**
 * @typedef {Object} EntityMeta
 * @property {string} id
 * @property {boolean} active
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/** @typedef {EntityMeta} CreateResult */
/** @typedef {EntityMeta} UpdateResult */

/**
 * @typedef {Object} DeleteResult
 * @property {number} deletedCount
 */

/**
 * @typedef {Object} ReadOptions
 * @property {number} [skip]
 * @property {number} [limit]
 * @property {Record<string, 1 | -1>} [sort]
 */

/**
 * Generic CRUD model.
 *
 * @template T
 * @typedef {Object} DLModel
 * @property {import('mongoose').Model<T>} Model
 * @property {Record<string, Record<string, string>>} [constants]
 *
 * @property {(data: object | object[]) => Promise<CreateResult | CreateResult[]>} create
 * @property {(filter?: import('mongoose').FilterQuery<T>, select?: object, options?: ReadOptions) => Promise<T[]>} read
 * @property {(id: string, select?: object) => Promise<T | null>} readById
 * @property {(filter: import('mongoose').FilterQuery<T>, select?: object) => Promise<T | null>} readOne
 * @property {(filter: import('mongoose').FilterQuery<T>, update: import('mongoose').UpdateQuery<T>, options?: object) => Promise<UpdateResult>} updateOne
 * @property {(filter: import('mongoose').FilterQuery<T>, update: import('mongoose').UpdateQuery<T>, options?: object) => Promise<{ acknowledged: boolean, modifiedCount: number }>} update
 * @property {(filter: import('mongoose').FilterQuery<T>) => Promise<DeleteResult>} deleteOne
 * @property {(filter?: import('mongoose').FilterQuery<T>, search?: string) => Promise<number>} count
 * @property {(value: string, filter?: import('mongoose').FilterQuery<T>, options?: ReadOptions) => Promise<T[]>} search
 */

/**
 * @typedef {DLModel<any>} DL.Admin
 */

/**
 * @typedef {DLModel<any>} DL.User
 */

/**
 * @typedef {Object} ProductConstants
 * @property {Record<string,string>} PASSOVER_KASHRUT
 * @property {Record<string,string>} UNIT
 * @property {Record<string,string>} BASE_UNIT
 * @property {Record<string,string>} STORAGE_TYPE
 * @property {Record<string,string>} STATUS
 */

/**
 * @typedef {DLModel<any> & {
 *   constants: ProductConstants
 * }} DL.Product
 */

/**
 * @typedef {DLModel<any>} DL.Store
 */

/**
 * @typedef {Object} OrderConstants
 * @property {Record<string,string>} CASH_REGISTER_STATUS
 * @property {Record<string,string>} USER_APPROVAL
 * @property {Record<string,string>} OWNER_STATUS
 * @property {Record<string,string>} ORDER_STATUS
 * @property {Record<string,string>} PICKUP_STATUS
 * @property {Record<string,string>} CART_PRODUCT_STATUS
 * @property {Record<string,string>} DELIVERY_METHOD
 */

/**
 * @typedef {DLModel<any> & {
 *   constants: OrderConstants
 * }} DL.Order
 */

/**
 * @typedef {Object} TimelineConstants
 * @property {Record<string,string>} EVENT_TYPES
 */

/**
 * @typedef {DLModel<any> & {
 *   constants: TimelineConstants
 * }} DL.Timeline
 */

/**
 * @typedef {Object} SaleConstants
 * @property {Record<string,string>} KINDS
 * @property {Record<string,string>} TYPES
 */

/**
 * @typedef {DLModel<any> & {
 *   constants: SaleConstants
 * }} DL.Sale
 */

/**
 * @typedef {Object} CouponConstants
 * @property {Record<string,string>} DEPARTMENTS
 * @property {Record<string,string>} BENEFITS
 * @property {Record<string,string>} STATUSES
 */

/**
 * @typedef {DLModel<any> & {
 *   constants: CouponConstants
 * }} DL.Coupon
 */

/**
 * @typedef {DLModel<any>} DL.Domain
 */

/**
 * @typedef {Object} SettingConstants
 * @property {Record<string,string>} formType
 * @property {Record<string,string>} renderType
 */

/**
 * @typedef {DLModel<any> & {
 *   constants: SettingConstants
 * }} DL.Setting
 */

/**
 * @typedef {Object} LogConstants
 * @property {Record<string,string>} STATUS
 * @property {Record<string,string>} ACTOR
 */

/**
 * @typedef {DLModel<any> & {
 *   constants: LogConstants
 * }} DL.Log
 */

/**
 * @typedef {DLModel<any>} DL.Role
 */

/**
 * @typedef {DLModel<any>} DL.Otp
 */

/**
 * @typedef {DLModel<any>} DL.CashRegister
 */

/**
 * @typedef {DLModel<any>} DL.ComaxDeliveryDoc
 */

/**
 * Root Data Layer.
 *
 * @typedef {Object} DL
 * @property {import('ioredis').Redis} redis
 *
 * @property {DL.Admin} Admin
 * @property {DL.User} User
 * @property {DL.Product} Product
 * @property {DL.Store} Store
 * @property {DL.Order} Order
 * @property {DL.Timeline} Timeline
 * @property {DL.Sale} Sale
 * @property {DL.Coupon} Coupon
 * @property {DL.Domain} Domain
 * @property {DL.Setting} Setting
 * @property {DL.Log} Log
 * @property {DL.Role} Role
 * @property {DL.Otp} Otp
 * @property {DL.CashRegister} CashRegister
 * @property {DL.ComaxDeliveryDoc} ComaxDeliveryDoc
 *
 * @property {(docs: any[], docField: string, sourceMap: Record<string, string>) => Promise<any[]>} populate
 */

export { }