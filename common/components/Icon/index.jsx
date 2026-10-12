import classNames from 'common/functions/classNames'
import styles from './icon.module.css'
import {
    LuPlus, LuPencil, LuTrash2, LuChevronLeft, LuChevronRight, LuChevronUp, LuChevronDown,
    LuDownload, LuSettings, LuSearch, LuEllipsis, LuUser, LuContact, LuMonitor,
    LuBell, LuLogOut, LuLayoutGrid, LuLayoutDashboard, LuBuilding, LuBuilding2, LuReplace,
    LuListChecks, LuHeadset, LuCircleHelp, LuClipboard, LuClipboardList, LuFileText, LuUsers,
    LuTable, LuKeyRound, LuCalendar, LuRefreshCw, LuX, LuCheck, LuCircleCheck, LuCalendarClock,
    LuSmartphone, LuMonitorSmartphone, LuUndo2, LuReceipt, LuUnfoldVertical, LuFoldVertical,
    LuLoader, LuCopy, LuShare, LuCircle, LuGithub, LuPlay, LuPause, LuShoppingCart, LuMapPin,
    LuShoppingBag, LuArrowUpDown, LuCode, LuPackage, LuStore, LuGlobe, LuPercent, LuTicket,
    LuSun, LuMoon, LuCloudUpload, LuMap, LuClock, LuTruck, LuCreditCard, LuBarcode, LuAlignLeft,
    LuListPlus, LuNotebookPen, LuPanelRightClose, LuPanelRightOpen, LuCalendarPlus, LuSlidersHorizontal,
    LuBoxes, LuLightbulb, LuSnowflake, LuImage, LuBadgePercent, LuGalleryVerticalEnd, LuGalleryHorizontalEnd, LuHistory, LuPhone, LuMail, LuMessageSquare, LuArrowRightLeft, LuCalculator, LuArchiveRestore,
    LuUpload, LuPhoneOutgoing, LuInfo, LuHeart, LuScissors, LuHouse, LuShieldCheck, LuDoorOpen, LuMilk, LuSprayCan, LuCroissant, LuCigarette, LuBeef, LuShoppingBasket, LuApple, LuBaby, LuSparkles, LuCupSoda, LuCircleUserRound, LuScrollText
} from 'react-icons/lu'
import { BsFileEarmarkExcel } from 'react-icons/bs'
import { TbHeartPlus } from 'react-icons/tb'
import { SiWaze } from 'react-icons/si'
import { FaWhatsapp, FaFacebookF, FaInstagram, FaLinkedinIn, FaTiktok, FaXTwitter } from 'react-icons/fa6'

const iconsList = {
    add: LuPlus,
    edit: LuPencil,
    trash: LuTrash2,
    left: LuChevronLeft,
    right: LuChevronRight,
    download: LuDownload,
    settings: LuSettings,
    menu: LuAlignLeft,// LuMenu,
    search: LuSearch,
    options: LuEllipsis,
    person: LuUser,
    persons: LuContact,
    desktop: LuMonitor,
    notifications: LuBell,
    exit: LuLogOut,
    logout: LuLogOut,
    fallback: LuLayoutGrid,
    dashboard: LuLayoutDashboard,
    buildings: LuBuilding2,
    building: LuBuilding,
    replace: LuReplace,
    placement: LuListChecks,
    tasks: LuHeadset,
    question: LuCircleHelp,
    clipboard: LuClipboard,
    clipboardList: LuClipboardList,
    reports: LuFileText,
    users: LuUsers,
    table: LuTable,
    key: LuKeyRound,
    calendar: LuCalendar,
    csv: BsFileEarmarkExcel,
    refresh: LuRefreshCw,
    x: LuX,
    v: LuCheck,
    payRepeat: LuCalendarClock,
    back: LuChevronRight,
    asign: LuSmartphone,
    release: LuMonitorSmartphone,
    refund: LuUndo2,
    receipt: LuReceipt,
    invoice: LuFileText,
    expand: LuUnfoldVertical,
    collapse: LuFoldVertical,
    load: LuLoader,
    copy: LuCopy,
    share: LuShare,
    down: LuChevronDown,
    calendarAdd: LuCalendarPlus,
    check: LuCircleCheck,
    checkEmpty: LuCircle,
    github: LuGithub,
    play: LuPlay,
    pause: LuPause,
    cart: props => <LuShoppingCart style={{ transform: 'scaleX(-1)' }} {...props} />,
    sort: LuArrowUpDown,
    sortUp: LuChevronUp,
    sortDown: LuChevronDown,
    log: LuCode,
    products: LuPackage,
    orders: LuShoppingBag,
    stores: LuStore,
    domains: LuGlobe,
    sale: LuPercent,
    salePercent: LuBadgePercent,
    coupon: LuTicket,
    toMini: LuPanelRightClose,
    unMini: LuPanelRightOpen,
    darkMode: LuMoon,
    lightMode: LuSun,
    sync: LuCloudUpload,
    user: LuUser,
    map: LuMap,
    time: LuClock,
    bag: LuShoppingBag,
    truck: props => <LuTruck style={{ transform: 'scaleX(-1)' }} {...props} />,
    card: LuCreditCard,
    barcode: LuBarcode,
    listPlus: LuListPlus,
    heartPlus: TbHeartPlus,
    note: LuNotebookPen,
    scrollText: LuScrollText,
    filter: LuSlidersHorizontal,
    location: LuMapPin,
    stockSync: LuBoxes,
    stock: LuBoxes,
    bulb: LuLightbulb,
    snow: LuSnowflake,
    image: LuImage,
    box: LuPackage,
    history: LuHistory,
    phone: LuPhone,
    phoneOutgoing: LuPhoneOutgoing,
    waze: SiWaze,
    mail: LuMail,
    message: LuMessageSquare,
    statusChange: LuArrowRightLeft,
    calculator: LuCalculator,
    restore: LuArchiveRestore,
    upload: LuUpload,
    blocks: LuGalleryVerticalEnd,
    carousel: LuGalleryHorizontalEnd,
    whatsapp: FaWhatsapp,
    info: LuInfo,
    heart: LuHeart,
    home: LuHouse,
    shield: LuShieldCheck,
    door: LuDoorOpen,
    milk: LuMilk,
    spray: LuSprayCan,
    croissant: LuCroissant,
    cigarette: LuCigarette,
    beef: LuBeef,
    basket: LuShoppingBasket,
    apple: LuApple,
    baby: LuBaby,
    sparkles: LuSparkles,
    cup: LuCupSoda,
    circleUser: LuCircleUserRound,
    grid: LuLayoutGrid,
    cut: LuScissors,
    facebook: FaFacebookF,
    instagram: FaInstagram,
    linkedin: FaLinkedinIn,
    tiktok: FaTiktok,
    twitter: FaXTwitter
}

/**
 * All supported icon names extracted directly from the keys of iconsList.
 *
 * @typedef {keyof typeof iconsList} IconNames
 */

/**
 * Icon component.
 *
 * Renders an SVG icon from `react-icons/lu` (Lucide) based on the provided name.
 * Additional props are forwarded to the underlying SVG element.
 *
 * @param {Object} props
 * @param {IconNames} props.name - Icon identifier
 * @param {string} [props.className] - Additional CSS class names
 * @param {boolean} [props.fallback=false] - Use fallback icon if name is invalid
 * @param {...import('react').SVGProps<SVGSVGElement>} [props] - SVG props
 * @returns {JSX.Element|null}
 */
export default function Icon({ className, name, fallback = false, ...props }) {
    let I = iconsList[name]
    if (!I && fallback) I = iconsList.fallback

    return I ? <I
        aria-label={`icon ${name}`}
        className={classNames(styles.icon, className)}
        {...props}
    /> : null
}
