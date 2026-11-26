/**
 * Where a home's weather comes from (docs/architecture/weather.md): one of 63
 * fixed areas, the provinces and cities as they were before the 2025 merger,
 * each at its former administrative centre. The user picks the province (one
 * of today's 34), then the area inside it. Never GPS, never finer than an old
 * province: 63 areas cost the same number of forecast calls whether 10 or
 * 10,000 homes use them.
 */
export interface Province {
    code: string;
    name: string;
    latitude: number;
    longitude: number;
}

export interface Area {
    /** The old province's code ("binh_duong"). */
    code: string;
    /** The old province's name ("Bình Dương"). */
    name: string;
    /** Today's province it belongs to. */
    province: string;
    /** Its former administrative centre (where its forecast is read). */
    latitude: number;
    longitude: number;
}

/** Today's 34 provinces and cities, each at its administrative centre (one of its areas). */
export const PROVINCES: readonly Province[] = [
    { code: 'ha_noi', name: 'Hà Nội', latitude: 21.03, longitude: 105.85 },
    { code: 'hue', name: 'Huế', latitude: 16.46, longitude: 107.59 },
    { code: 'hai_phong', name: 'Hải Phòng', latitude: 20.86, longitude: 106.68 },
    { code: 'da_nang', name: 'Đà Nẵng', latitude: 16.05, longitude: 108.2 },
    { code: 'ho_chi_minh', name: 'TP. Hồ Chí Minh', latitude: 10.78, longitude: 106.7 },
    { code: 'can_tho', name: 'Cần Thơ', latitude: 10.03, longitude: 105.79 },
    { code: 'lai_chau', name: 'Lai Châu', latitude: 22.4, longitude: 103.46 },
    { code: 'dien_bien', name: 'Điện Biên', latitude: 21.39, longitude: 103.02 },
    { code: 'son_la', name: 'Sơn La', latitude: 21.33, longitude: 103.91 },
    { code: 'lang_son', name: 'Lạng Sơn', latitude: 21.85, longitude: 106.76 },
    { code: 'cao_bang', name: 'Cao Bằng', latitude: 22.67, longitude: 106.26 },
    { code: 'quang_ninh', name: 'Quảng Ninh', latitude: 20.95, longitude: 107.08 },
    { code: 'thanh_hoa', name: 'Thanh Hóa', latitude: 19.81, longitude: 105.78 },
    { code: 'nghe_an', name: 'Nghệ An', latitude: 18.68, longitude: 105.68 },
    { code: 'ha_tinh', name: 'Hà Tĩnh', latitude: 18.34, longitude: 105.91 },
    { code: 'tuyen_quang', name: 'Tuyên Quang', latitude: 21.82, longitude: 105.21 },
    { code: 'lao_cai', name: 'Lào Cai', latitude: 21.72, longitude: 104.91 },
    { code: 'thai_nguyen', name: 'Thái Nguyên', latitude: 21.59, longitude: 105.85 },
    { code: 'phu_tho', name: 'Phú Thọ', latitude: 21.32, longitude: 105.4 },
    { code: 'bac_ninh', name: 'Bắc Ninh', latitude: 21.27, longitude: 106.19 },
    { code: 'hung_yen', name: 'Hưng Yên', latitude: 20.65, longitude: 106.05 },
    { code: 'ninh_binh', name: 'Ninh Bình', latitude: 20.25, longitude: 105.97 },
    { code: 'quang_tri', name: 'Quảng Trị', latitude: 17.47, longitude: 106.62 },
    { code: 'quang_ngai', name: 'Quảng Ngãi', latitude: 15.12, longitude: 108.8 },
    { code: 'gia_lai', name: 'Gia Lai', latitude: 13.78, longitude: 109.22 },
    { code: 'khanh_hoa', name: 'Khánh Hòa', latitude: 12.24, longitude: 109.19 },
    { code: 'lam_dong', name: 'Lâm Đồng', latitude: 11.94, longitude: 108.44 },
    { code: 'dak_lak', name: 'Đắk Lắk', latitude: 12.67, longitude: 108.04 },
    { code: 'dong_nai', name: 'Đồng Nai', latitude: 10.95, longitude: 106.82 },
    { code: 'tay_ninh', name: 'Tây Ninh', latitude: 10.54, longitude: 106.41 },
    { code: 'vinh_long', name: 'Vĩnh Long', latitude: 10.25, longitude: 105.97 },
    { code: 'dong_thap', name: 'Đồng Tháp', latitude: 10.36, longitude: 106.36 },
    { code: 'ca_mau', name: 'Cà Mau', latitude: 9.18, longitude: 105.15 },
    { code: 'an_giang', name: 'An Giang', latitude: 10.01, longitude: 105.08 },
];

const area = (code: string, name: string, province: string, latitude: number, longitude: number): Area =>
    ({ code, name, province, latitude, longitude });

/** The 63 provinces and cities before the 2025 merger, by today's province (its centre first). */
export const AREAS: readonly Area[] = [
    // Not merged.
    area('ha_noi', 'Hà Nội', 'ha_noi', 21.03, 105.85),
    area('hue', 'Huế', 'hue', 16.46, 107.59),
    area('lai_chau', 'Lai Châu', 'lai_chau', 22.4, 103.46),
    area('dien_bien', 'Điện Biên', 'dien_bien', 21.39, 103.02),
    area('son_la', 'Sơn La', 'son_la', 21.33, 103.91),
    area('lang_son', 'Lạng Sơn', 'lang_son', 21.85, 106.76),
    area('cao_bang', 'Cao Bằng', 'cao_bang', 22.67, 106.26),
    area('quang_ninh', 'Quảng Ninh', 'quang_ninh', 20.95, 107.08),
    area('thanh_hoa', 'Thanh Hóa', 'thanh_hoa', 19.81, 105.78),
    area('nghe_an', 'Nghệ An', 'nghe_an', 18.68, 105.68),
    area('ha_tinh', 'Hà Tĩnh', 'ha_tinh', 18.34, 105.91),
    // Merged in 2025.
    area('tuyen_quang', 'Tuyên Quang', 'tuyen_quang', 21.82, 105.21),
    area('ha_giang', 'Hà Giang', 'tuyen_quang', 22.82, 104.98),
    area('yen_bai', 'Yên Bái', 'lao_cai', 21.72, 104.91),
    area('lao_cai', 'Lào Cai', 'lao_cai', 22.49, 103.97),
    area('thai_nguyen', 'Thái Nguyên', 'thai_nguyen', 21.59, 105.85),
    area('bac_kan', 'Bắc Kạn', 'thai_nguyen', 22.15, 105.83),
    area('phu_tho', 'Phú Thọ', 'phu_tho', 21.32, 105.4),
    area('vinh_phuc', 'Vĩnh Phúc', 'phu_tho', 21.31, 105.6),
    area('hoa_binh', 'Hòa Bình', 'phu_tho', 20.82, 105.34),
    area('bac_giang', 'Bắc Giang', 'bac_ninh', 21.27, 106.19),
    area('bac_ninh', 'Bắc Ninh', 'bac_ninh', 21.18, 106.07),
    area('hung_yen', 'Hưng Yên', 'hung_yen', 20.65, 106.05),
    area('thai_binh', 'Thái Bình', 'hung_yen', 20.45, 106.34),
    area('hai_phong', 'Hải Phòng', 'hai_phong', 20.86, 106.68),
    area('hai_duong', 'Hải Dương', 'hai_phong', 20.94, 106.33),
    area('ninh_binh', 'Ninh Bình', 'ninh_binh', 20.25, 105.97),
    area('ha_nam', 'Hà Nam', 'ninh_binh', 20.54, 105.91),
    area('nam_dinh', 'Nam Định', 'ninh_binh', 20.42, 106.17),
    area('quang_binh', 'Quảng Bình', 'quang_tri', 17.47, 106.62),
    area('quang_tri', 'Quảng Trị', 'quang_tri', 16.82, 107.1),
    area('da_nang', 'Đà Nẵng', 'da_nang', 16.05, 108.2),
    area('quang_nam', 'Quảng Nam', 'da_nang', 15.57, 108.47),
    area('quang_ngai', 'Quảng Ngãi', 'quang_ngai', 15.12, 108.8),
    area('kon_tum', 'Kon Tum', 'quang_ngai', 14.35, 108),
    area('binh_dinh', 'Bình Định', 'gia_lai', 13.78, 109.22),
    area('gia_lai', 'Gia Lai', 'gia_lai', 13.98, 108),
    area('khanh_hoa', 'Khánh Hòa', 'khanh_hoa', 12.24, 109.19),
    area('ninh_thuan', 'Ninh Thuận', 'khanh_hoa', 11.57, 108.99),
    area('lam_dong', 'Lâm Đồng', 'lam_dong', 11.94, 108.44),
    area('dak_nong', 'Đắk Nông', 'lam_dong', 12, 107.69),
    area('binh_thuan', 'Bình Thuận', 'lam_dong', 10.93, 108.1),
    area('dak_lak', 'Đắk Lắk', 'dak_lak', 12.67, 108.04),
    area('phu_yen', 'Phú Yên', 'dak_lak', 13.09, 109.3),
    area('ho_chi_minh', 'TP. Hồ Chí Minh', 'ho_chi_minh', 10.78, 106.7),
    area('binh_duong', 'Bình Dương', 'ho_chi_minh', 10.98, 106.65),
    area('ba_ria_vung_tau', 'Bà Rịa – Vũng Tàu', 'ho_chi_minh', 10.5, 107.17),
    area('dong_nai', 'Đồng Nai', 'dong_nai', 10.95, 106.82),
    area('binh_phuoc', 'Bình Phước', 'dong_nai', 11.53, 106.89),
    area('long_an', 'Long An', 'tay_ninh', 10.54, 106.41),
    area('tay_ninh', 'Tây Ninh', 'tay_ninh', 11.31, 106.1),
    area('can_tho', 'Cần Thơ', 'can_tho', 10.03, 105.79),
    area('soc_trang', 'Sóc Trăng', 'can_tho', 9.6, 105.97),
    area('hau_giang', 'Hậu Giang', 'can_tho', 9.78, 105.47),
    area('vinh_long', 'Vĩnh Long', 'vinh_long', 10.25, 105.97),
    area('ben_tre', 'Bến Tre', 'vinh_long', 10.24, 106.38),
    area('tra_vinh', 'Trà Vinh', 'vinh_long', 9.93, 106.35),
    area('tien_giang', 'Tiền Giang', 'dong_thap', 10.36, 106.36),
    area('dong_thap', 'Đồng Tháp', 'dong_thap', 10.46, 105.63),
    area('ca_mau', 'Cà Mau', 'ca_mau', 9.18, 105.15),
    area('bac_lieu', 'Bạc Liêu', 'ca_mau', 9.29, 105.72),
    area('kien_giang', 'Kiên Giang', 'an_giang', 10.01, 105.08),
    area('an_giang', 'An Giang', 'an_giang', 10.39, 105.44),
];

export function findProvince(code: string): Province | null {
    return PROVINCES.find(item => item.code === code) ?? null;
}

export function findArea(code: string): Area | null {
    return AREAS.find(item => item.code === code) ?? null;
}

/** The areas of a province, its centre first. */
export function areasOf(province: string): Area[] {
    return AREAS.filter(item => item.province === province);
}

/** The area at the province's centre: where a home is when only the province is picked. */
export function mainAreaOf(province: Province): Area {
    return AREAS.find(item => item.province === province.code
        && item.latitude === province.latitude && item.longitude === province.longitude)!;
}

/**
 * The area whose centre is closest to [latitude, longitude]: how a stored
 * home is read, so a home set before the areas existed (by ward or by
 * province) falls into the area around it.
 */
export function nearestArea(latitude: number, longitude: number): Area {
    let best = AREAS[0];
    let bestDistance = Infinity;
    for (const candidate of AREAS) {
        // Small distances: an equirectangular projection is enough to compare.
        const x = (candidate.longitude - longitude) * Math.cos(((candidate.latitude + latitude) / 2) * Math.PI / 180);
        const y = candidate.latitude - latitude;
        const distance = x * x + y * y;
        if (distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
        }
    }
    return best;
}

/** How the home is named to the user: "Hà Nội", "Bình Dương (TP. Hồ Chí Minh)". */
export function placeOf(item: Area): string {
    const province = findProvince(item.province)!;
    return item.name === province.name ? province.name : `${item.name} (${province.name})`;
}
