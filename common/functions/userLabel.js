export function getTimeOfDay(date = new Date()) {
    const hour = date.getHours()

    if (hour >= 5 && hour < 12) {
        return 'morning'
    } else if (hour >= 12 && hour < 17) {
        return 'afternoon'
    } else if (hour >= 17 && hour < 21) {
        return 'evening'
    } else {
        return 'night'
    }
}

export function getUserTitle(user) {
    return user?.id ? `good ${getTimeOfDay()}` : 'login_register_btn'
}

export function getUserSubtitle(user) {
    if (!user?.id) return 'login_register_subTitle'
    return `${user.name?.first || ''} ${user.name?.last || ''}`.trim()
}
