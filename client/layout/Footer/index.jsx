import Logo from 'common/components/Logo'
import Icon from 'common/components/Icon'
import Text from 'common/components/Text'
import classNames from 'common/functions/classNames'
import { getSettingFileUrl } from 'common/functions/settingFileUrl'
import whatsappUrl from 'common/functions/whatsappUrl'
import { useAppData } from 'App'
import { useText } from 'common/texts/TextProvider'
import { Link } from 'react-router'
import styles from './footer.module.css'

// Rendered when the store has no `footer` settings yet. Rows without a
// `to`/`href` are intentionally inert - the admin replaces them from
// Settings -> footer -> columns.
const DEFAULT_COLUMNS = [
    {
        title: 'footer_title_news',
        links: [
            { text: 'footer_link_faq' },
            { text: 'footer_link_accessibility' },
            { text: 'footer_link_press', tag: 'footer_tag_new' },
            { text: 'footer_link_shipping_methods' }
        ]
    },
    {
        title: 'footer_title_guide',
        links: [
            { text: 'footer_link_products' },
            { text: 'footer_link_accessibility' },
            { text: 'footer_link_press', tag: 'footer_tag_new' },
            { text: 'footer_link_shipping_methods' }
        ]
    }
]

const DEFAULT_SOCIAL = [
    { icon: 'facebook', text: 'aria_facebook' },
    { icon: 'instagram', text: 'aria_instagram' },
    { icon: 'linkedin', text: 'aria_linkedin' },
    { icon: 'tiktok', text: 'aria_tiktok' },
    { icon: 'twitter', text: 'aria_twitter' }
]

function LinkRow({ row }) {
    const { text, tag, to, href } = row
    const { TR } = useText?.() || {}

    const body = <>
        <Text size='m'>{text}</Text>
        {tag && <span className={styles.tag}>{TR?.(tag) || tag}</span>}
    </>

    if (to) return <Link className={styles.row} to={to}>{body}</Link>
    if (href) return <a className={styles.row} href={href} target='_blank' rel='noopener noreferrer'>{body}</a>
    return <span className={classNames(styles.row, styles.inert)}>{body}</span>
}

function ContactRow({ row }) {
    const { icon, text, href, label } = row
    const { TR } = useText?.() || {}

    const body = <>
        <Icon name={icon} className={styles.contactIcon} aria-hidden />
        <Text size='m'>{text}</Text>
    </>

    if (!href) return <span className={classNames(styles.row, styles.inert)}>{body}</span>

    const external = href.startsWith('http')
    return <a
        className={styles.row}
        href={href}
        aria-label={`${TR?.(label) || ''}: ${text}`.trim()}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >{body}</a>
}

function SocialItem({ item }) {
    const { icon, text, href } = item
    const { TR } = useText?.() || {}

    const glyph = <Icon name={icon} aria-label={TR?.(text) || undefined} />
    return href
        ? <a className={styles.socialItem} href={href} target='_blank' rel='noopener noreferrer'>{glyph}</a>
        : <span className={classNames(styles.socialItem, styles.inert)}>{glyph}</span>
}

export default function Footer() {
    const { settings = {} } = useAppData?.() || {}
    const { TR } = useText?.() || {}

    const footer = settings?.footer || {}
    const customerService = settings?.customerservice || {}

    const columns = Array.isArray(footer.columns) && footer.columns.length ? footer.columns : DEFAULT_COLUMNS
    const social = Array.isArray(footer.social) && footer.social.length ? footer.social : DEFAULT_SOCIAL

    const email = footer.email || customerService.email || 'admin@shefa.click'
    const phone = footer.phone || customerService.phone || '053-1234567'
    const whatsapp = footer.whatsappNumber || customerService.whatsappNumber || '053-1234567'

    const contact = [
        { icon: 'mail', label: 'aria_email', text: email, href: `mailto:${email}` },
        { icon: 'phone', label: 'aria_phone', text: phone, href: `tel:${phone.replace(/[^\d+]/g, '')}` },
        { icon: 'whatsapp', label: 'aria_whatsapp', text: whatsapp, href: whatsappUrl(whatsapp) }
    ].filter(({ text, href }) => !!text && !!href)

    return <footer className={styles.footer}>
        <div className={styles.inner}>
            <div className={styles.top}>
                <div className={styles.brand}>
                    <Logo
                        className={styles.logo}
                        src={getSettingFileUrl(settings?.appearance?.logo) || undefined}
                        darkSrc={getSettingFileUrl(settings?.appearance?.logoDark) || undefined}
                    />
                    <Text className={styles.tagline} size='s'>footer_tagline</Text>
                </div>

                {columns.map(({ title, links = [] }, ci) => <div key={ci} className={styles.column}>
                    {title && <Text tag='h2' size='m' bold className={styles.columnTitle}>{title}</Text>}
                    <ul className={styles.list}>
                        {links.map((row, ri) => <li key={ri} className={styles.item}>
                            <LinkRow row={row} />
                        </li>)}
                    </ul>
                </div>)}

                <div className={styles.column}>
                    <Text tag='h2' size='m' bold className={styles.columnTitle}>footer_title_contact</Text>
                    <ul className={classNames(styles.list, styles.contactList)}>
                        {contact.map((row, ri) => <li key={ri} className={styles.item}>
                            <ContactRow row={row} />
                        </li>)}
                    </ul>
                </div>
            </div>

            <div className={styles.bottom}>
                <nav className={styles.social} aria-label={TR?.('footer_social')}>
                    {social.map((item, si) => <SocialItem key={si} item={item} />)}
                </nav>
                <Text size='s' className={styles.copyright}>footer_powered_by</Text>
            </div>
        </div>
    </footer>
}