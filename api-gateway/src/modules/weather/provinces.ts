/**
 * The 34 provinces and cities of Vietnam (since the 2025 merger), each at its
 * administrative centre: where a home is when the user picks only a province.
 * A searched place (ward, commune, district) is closer; neither is GPS.
 */
export interface Province {
    code: string;
    name: string;
    latitude: number;
    longitude: number;
}

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

export function findProvince(code: string): Province | null {
    return PROVINCES.find(item => item.code === code) ?? null;
}

/** The province whose centre is closest to [latitude, longitude] (for the mock weather of an area). */
export function nearestProvince(latitude: number, longitude: number): Province {
    let best = PROVINCES[0];
    let bestDistance = Infinity;
    for (const province of PROVINCES) {
        // Small distances: an equirectangular projection is enough to compare.
        const x = (province.longitude - longitude) * Math.cos(((province.latitude + latitude) / 2) * Math.PI / 180);
        const y = province.latitude - latitude;
        const distance = x * x + y * y;
        if (distance < bestDistance) {
            best = province;
            bestDistance = distance;
        }
    }
    return best;
}
